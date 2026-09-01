import { createHash } from "node:crypto";

import { EventStore, type Event } from "./events.js";
import { fold, type GraphNode } from "./reducer.js";

export type FleetRequestStatus = "queued" | "adopted" | "running" | "done" | "failed" | "expired";

export interface FleetRequest {
  id: string;
  project_id: string;
  node_id: string;
  status: FleetRequestStatus;
  outcome: string | null;
  note: string | null;
  created_at: string;
  adopted_at: string | null;
  finished_at: string | null;
}

export interface FleetQueueOptions {
  seedProjectId?: string;
  dailyCap: number;
  perProjectCap: number;
  adoptTtlMin: number;
  id: () => string;
}

export class FleetQueueError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FleetQueueError";
  }
}

const workerLifecycleTypes = new Set([
  "NODE_STATE_CHANGED",
  "PAUSE_ACKED",
  "WORKER_LOG",
  "HANDOFF_FILED",
  "DEVIATION_NOTED",
  "APPROVAL_CREATED",
]);

function templateHash(node: Pick<GraphNode, "title" | "brief">): string {
  return createHash("sha256").update(`${node.title}\n${node.brief}`).digest("hex");
}

function row(value: unknown): FleetRequest {
  return value as FleetRequest;
}

function nodeId(event: Event): string | undefined {
  return "node_id" in event.payload ? event.payload.node_id : undefined;
}

export class FleetQueue {
  constructor(
    private readonly store: EventStore,
    private readonly options: FleetQueueOptions,
  ) {}

  enqueue(projectId: string, nodeId: string, at: Date): { request: FleetRequest; position: number } {
    const timestamp = at.toISOString();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.sweepWithinTransaction(timestamp);
      this.requireEligible(projectId, nodeId);
      const duplicate = this.store.database
        .prepare(
          `SELECT 1 AS found FROM fleet_requests
           WHERE project_id = ? AND node_id = ? AND status <> 'expired' LIMIT 1`,
        )
        .get(projectId, nodeId);
      if (duplicate) {
        throw new FleetQueueError(409, "fleet_request_exists", "A fleet request already exists for this node.");
      }
      const projectUsed = this.store.database
        .prepare("SELECT COUNT(*) AS count FROM fleet_requests WHERE project_id = ? AND status <> 'expired'")
        .get(projectId) as { count: number };
      if (projectUsed.count >= this.options.perProjectCap) {
        throw new FleetQueueError(429, "fleet_project_cap", "This project has reached its fleet request cap.");
      }
      const { start, end } = this.utcDay(at);
      const dailyUsed = this.store.database
        .prepare("SELECT COUNT(*) AS count FROM fleet_requests WHERE created_at >= ? AND created_at < ?")
        .get(start, end) as { count: number };
      if (dailyUsed.count >= this.options.dailyCap) {
        throw new FleetQueueError(429, "fleet_daily_cap", "The fleet has reached its daily request cap.");
      }
      const request: FleetRequest = {
        id: this.options.id(),
        project_id: projectId,
        node_id: nodeId,
        status: "queued",
        outcome: null,
        note: null,
        created_at: timestamp,
        adopted_at: null,
        finished_at: null,
      };
      this.store.database
        .prepare(
          `INSERT INTO fleet_requests
            (id, project_id, node_id, status, outcome, note, created_at, adopted_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          request.project_id,
          request.node_id,
          request.status,
          request.outcome,
          request.note,
          request.created_at,
          request.adopted_at,
          request.finished_at,
        );
      const position = this.positionWithinTransaction(request.id);
      this.store.database.exec("COMMIT");
      return { request, position };
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  get(projectId: string, requestId: string, at: Date): { request: FleetRequest; position?: number } {
    this.sweep(at);
    const found = this.store.database
      .prepare("SELECT * FROM fleet_requests WHERE id = ? AND project_id = ?")
      .get(requestId, projectId);
    if (!found) {
      throw new FleetQueueError(404, "fleet_request_not_found", "Fleet request does not exist.");
    }
    const request = row(found);
    return {
      request,
      ...(request.status === "queued" ? { position: this.positionWithinTransaction(request.id) } : {}),
    };
  }

  status(projectId: string, at: Date): {
    queue_depth: number;
    daily_remaining: number;
    project_remaining: number;
  } {
    this.sweep(at);
    const queue = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM fleet_requests WHERE status = 'queued'")
      .get() as { count: number };
    const projectUsed = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM fleet_requests WHERE project_id = ? AND status <> 'expired'")
      .get(projectId) as { count: number };
    const { start, end } = this.utcDay(at);
    const dailyUsed = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM fleet_requests WHERE created_at >= ? AND created_at < ?")
      .get(start, end) as { count: number };
    return {
      queue_depth: queue.count,
      daily_remaining: Math.max(0, this.options.dailyCap - dailyUsed.count),
      project_remaining: Math.max(0, this.options.perProjectCap - projectUsed.count),
    };
  }

  claimNext(at: Date): {
    request_id: string;
    project_id: string;
    node_id: string;
    node: { title: string; brief: string; estimate: number };
    visitor_token: string;
  } | undefined {
    const timestamp = at.toISOString();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.sweepWithinTransaction(timestamp);
      while (true) {
        const found = this.store.database
          .prepare("SELECT * FROM fleet_requests WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1")
          .get();
        if (!found) {
          this.store.database.exec("COMMIT");
          return undefined;
        }
        const request = row(found);
        const eligibility = this.eligibility(request.project_id, request.node_id);
        if (!eligibility.eligible) {
          this.store.database
            .prepare(
              `UPDATE fleet_requests
               SET status = 'failed', outcome = 'stale', finished_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(timestamp, request.id);
          continue;
        }
        this.store.database
          .prepare("UPDATE fleet_requests SET status = 'adopted', adopted_at = ? WHERE id = ? AND status = 'queued'")
          .run(timestamp, request.id);
        const project = this.store.getProject(request.project_id);
        if (!project) {
          throw new FleetQueueError(404, "project_not_found", `Project ${request.project_id} does not exist.`);
        }
        const result = {
          request_id: request.id,
          project_id: request.project_id,
          node_id: request.node_id,
          node: {
            title: eligibility.node.title,
            brief: eligibility.node.brief,
            estimate: eligibility.node.estimate_min,
          },
          visitor_token: project.visitor_token,
        };
        this.store.database.exec("COMMIT");
        return result;
      }
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(requestId: string, at: Date): FleetRequest {
    const timestamp = at.toISOString();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.sweepWithinTransaction(timestamp);
      const found = this.store.database.prepare("SELECT * FROM fleet_requests WHERE id = ?").get(requestId);
      if (!found) throw new FleetQueueError(404, "fleet_request_not_found", "Fleet request does not exist.");
      const request = row(found);
      if (request.status === "adopted") {
        this.store.database.prepare("UPDATE fleet_requests SET status = 'running' WHERE id = ?").run(requestId);
        request.status = "running";
      } else if (request.status !== "running") {
        throw new FleetQueueError(409, "fleet_request_state", `Fleet request is ${request.status}.`);
      }
      this.store.database.exec("COMMIT");
      return request;
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(requestId: string, outcome: "done" | "failed", note: string | undefined, at: Date): FleetRequest {
    const timestamp = at.toISOString();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.sweepWithinTransaction(timestamp);
      const found = this.store.database.prepare("SELECT * FROM fleet_requests WHERE id = ?").get(requestId);
      if (!found) throw new FleetQueueError(404, "fleet_request_not_found", "Fleet request does not exist.");
      const request = row(found);
      if (request.status === outcome) {
        this.store.database.exec("COMMIT");
        return request;
      }
      if (request.status !== "adopted" && request.status !== "running") {
        throw new FleetQueueError(409, "fleet_request_state", `Fleet request is ${request.status}.`);
      }
      this.store.database
        .prepare("UPDATE fleet_requests SET status = ?, outcome = ?, note = ?, finished_at = ? WHERE id = ?")
        .run(outcome, outcome, note ?? null, timestamp, requestId);
      request.status = outcome;
      request.outcome = outcome;
      request.note = note ?? null;
      request.finished_at = timestamp;
      this.store.database.exec("COMMIT");
      return request;
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  private eligibility(
    projectId: string,
    requestedNodeId: string,
  ): { eligible: true; node: GraphNode } | { eligible: false; code: string } {
    const events = this.store.listEvents(projectId);
    const state = fold(events);
    const requested = state.nodes[requestedNodeId];
    if (!requested || requested.record_type !== "task") return { eligible: false, code: "node_not_found" };
    if (projectId === this.options.seedProjectId) return { eligible: false, code: "template_mismatch" };
    const hasWorkerLifecycle = events.some(
      (event) => workerLifecycleTypes.has(event.type) && nodeId(event) === requestedNodeId,
    );
    if (requested.state !== "queued" || !requested.assigned || hasWorkerLifecycle) {
      return { eligible: false, code: "node_not_dispatched" };
    }
    const templateEvents = this.options.seedProjectId && this.store.hasProject(this.options.seedProjectId)
      ? this.store.listEvents(this.options.seedProjectId)
      : [];
    const templateState = fold(templateEvents);
    const requestedHash = templateHash(requested);
    const matchesTemplate = Object.values(templateState.nodes).some(
      (template) => template.record_type === "task" && templateHash(template) === requestedHash,
    );
    if (!matchesTemplate) return { eligible: false, code: "template_mismatch" };
    return { eligible: true, node: requested };
  }

  private requireEligible(projectId: string, requestedNodeId: string): GraphNode {
    const result = this.eligibility(projectId, requestedNodeId);
    if (result.eligible) return result.node;
    switch (result.code) {
      case "node_not_found":
        throw new FleetQueueError(404, "node_not_found", `Node ${requestedNodeId} does not exist.`);
      case "template_mismatch":
        throw new FleetQueueError(400, "template_mismatch", "The node does not match the seed template registry.");
      default:
        throw new FleetQueueError(400, "node_not_dispatched", "The node is not dispatched or already has worker events.");
    }
  }

  private sweep(at: Date): void {
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.sweepWithinTransaction(at.toISOString());
      this.store.database.exec("COMMIT");
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  private sweepWithinTransaction(timestamp: string): void {
    const cutoff = new Date(Date.parse(timestamp) - this.options.adoptTtlMin * 60_000).toISOString();
    this.store.database
      .prepare(
        `UPDATE fleet_requests
         SET status = 'expired', finished_at = ?
         WHERE status IN ('adopted', 'running') AND adopted_at <= ?`,
      )
      .run(timestamp, cutoff);
  }

  private positionWithinTransaction(requestId: string): number {
    const result = this.store.database
      .prepare(
        `SELECT COUNT(*) AS position
         FROM fleet_requests, (
           SELECT created_at AS target_created_at, rowid AS target_rowid
           FROM fleet_requests WHERE id = ?
         ) AS target
         WHERE status = 'queued'
           AND (
             created_at < target.target_created_at
             OR (created_at = target.target_created_at AND rowid <= target.target_rowid)
           )`,
      )
      .get(requestId) as { position: number };
    return result.position;
  }

  private utcDay(at: Date): { start: string; end: string } {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    return { start: start.toISOString(), end: new Date(start.getTime() + 24 * 60 * 60_000).toISOString() };
  }
}
