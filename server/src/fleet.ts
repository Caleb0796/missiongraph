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

type FleetEligibility =
  | { eligible: true; node: GraphNode }
  | { eligible: false; code: string; message: string };

const workerLifecycleTypes = new Set([
  "NODE_STATE_CHANGED",
  "PAUSE_ACKED",
  "WORKER_LOG",
  "HANDOFF_FILED",
  "DEVIATION_NOTED",
  "APPROVAL_CREATED",
]);

function canonicalizeTitle(title: string): string {
  const singleLine = title
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(singleLine);
  return characters.length <= 80
    ? singleLine
    : `${characters.slice(0, 79).join("").trimEnd()}…`;
}

function templateHash(node: Pick<GraphNode, "title" | "brief">): string {
  return createHash("sha256").update(`${node.title}\n${node.brief}`).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function dispatchSubjectHash(event: Extract<Event, { type: "DISPATCHED" }>): string {
  const payload = {
    node_id: event.payload.node_id,
    ...(event.payload.brief_override === undefined ? {} : { brief_override: event.payload.brief_override }),
    bypass_cap: event.payload.bypass_cap,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ type: event.type, payload })))
    .digest("hex");
}

function row(value: unknown): FleetRequest {
  return value as FleetRequest;
}

function nodeId(event: Event): string | undefined {
  return "node_id" in event.payload ? event.payload.node_id : undefined;
}

function createsNode(event: Event, requestedNodeId: string): boolean {
  if (event.type === "TASK_ADDED") return event.payload.node.id === requestedNodeId;
  if (event.type === "TASK_SPLIT") {
    return event.payload.children.some((child) => child.id === requestedNodeId);
  }
  return false;
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

  eligibleNodeIds(projectId: string): string[] {
    return this.eligibilityProjection(projectId).eligibleNodes.map((node) => node.id);
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
          const outcome = eligibility.code === "template_mismatch" ? eligibility.code : "stale";
          this.store.database
            .prepare(
              `UPDATE fleet_requests
               SET status = 'failed', outcome = ?, note = ?, finished_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(outcome, eligibility.message, timestamp, request.id);
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
        this.store.database
          .prepare("UPDATE fleet_requests SET status = 'running', adopted_at = ? WHERE id = ?")
          .run(timestamp, requestId);
        request.status = "running";
      } else if (request.status !== "running") {
        throw new FleetQueueError(409, "fleet_request_state", `Fleet request is ${request.status}.`);
      } else {
        this.store.database.prepare("UPDATE fleet_requests SET adopted_at = ? WHERE id = ?").run(timestamp, requestId);
      }
      request.adopted_at = timestamp;
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
  ): FleetEligibility {
    const projection = this.eligibilityProjection(projectId);
    const { events, state, baseline, templateHashes } = projection;
    const requested = state.nodes[requestedNodeId];
    if (!requested || requested.record_type !== "task") {
      return { eligible: false, code: "node_not_found", message: `Node ${requestedNodeId} does not exist.` };
    }
    if (projectId === this.options.seedProjectId) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: "The seed project is the demo mission template, so it cannot dispatch work to the shared live fleet.",
      };
    }
    const hasWorkerLifecycle = events.some(
      (event) => workerLifecycleTypes.has(event.type) && nodeId(event) === requestedNodeId,
    );
    if (requested.state !== "queued" || !requested.assigned || hasWorkerLifecycle) {
      return {
        eligible: false,
        code: "node_not_dispatched",
        message: "The node is not dispatched or already has worker events.",
      };
    }
    const hasBriefOverride = events.some(
      (event) =>
        event.type === "DISPATCHED" &&
        event.payload.node_id === requestedNodeId &&
        event.payload.brief_override !== undefined,
    );
    if (hasBriefOverride) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: `A custom brief (brief_override) was supplied for '${canonicalizeTitle(requested.title)}'. The shared live fleet only runs unchanged seeded tasks, so this dispatch is supervision-only: no live worker will start.`,
      };
    }
    const creation = events.find((event) => createsNode(event, requestedNodeId));
    const suggestion = this.seededTaskSuggestion(projection.eligibleNodes);
    if (baseline === undefined || !creation || creation.seq > baseline) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: `The shared live fleet only runs tasks that came with the demo mission unchanged. '${canonicalizeTitle(requested.title)}' was created in this session, so it is dispatched in supervision-only mode: no live worker will start.${suggestion}`,
      };
    }
    const requestedHash = templateHash(requested);
    if (!templateHashes.has(requestedHash)) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: `'${canonicalizeTitle(requested.title)}' was edited after cloning (its title or brief no longer matches the seeded task), so it is dispatched in supervision-only mode: no live worker will start.${suggestion}`,
      };
    }
    const authorizedDispatch = events.find((event) => {
      if (
        event.type !== "DISPATCHED" ||
        event.payload.node_id !== requestedNodeId ||
        baseline === undefined ||
        event.seq <= baseline ||
        !event.payload.authorization
      ) {
        return false;
      }
      return this.store.humanCapabilityUseMatches({
        projectId,
        ref: event.payload.authorization.capability_ref,
        nonce: event.payload.authorization.use_nonce,
        action: "dispatch",
        subjectHash: dispatchSubjectHash(event),
      });
    });
    if (!authorizedDispatch) {
      return {
        eligible: false,
        code: "node_not_dispatched",
        message: "The node lacks a clone-local, human-confirmed dispatch.",
      };
    }
    return { eligible: true, node: requested };
  }

  private eligibilityProjection(projectId: string) {
    const events = this.store.listEvents(projectId);
    const state = fold(events);
    const baseline = this.store.cloneBaseline(projectId);
    const templateEvents = this.options.seedProjectId && this.store.hasProject(this.options.seedProjectId)
      ? this.store.listEvents(this.options.seedProjectId)
      : [];
    const templateState = fold(templateEvents);
    const templateHashes = new Set(
      Object.values(templateState.nodes)
        .filter((node) => node.record_type === "task")
        .map(templateHash),
    );
    const createdAt = new Map<string, number>();
    const workerHistoryNodeIds = new Set<string>();
    const briefOverrideNodeIds = new Set<string>();
    for (const event of events) {
      if (event.type === "TASK_ADDED") createdAt.set(event.payload.node.id, event.seq);
      if (event.type === "TASK_SPLIT") {
        for (const child of event.payload.children) createdAt.set(child.id, event.seq);
      }
      const eventNodeId = nodeId(event);
      if (eventNodeId && workerLifecycleTypes.has(event.type)) {
        workerHistoryNodeIds.add(eventNodeId);
      }
      if (event.type === "DISPATCHED" && event.payload.brief_override !== undefined) {
        briefOverrideNodeIds.add(event.payload.node_id);
      }
    }
    const eligibleNodes = projectId === this.options.seedProjectId || baseline === undefined
      ? []
      : Object.values(state.nodes)
        .filter(
          (node) =>
            node.record_type === "task" &&
            node.state === "queued" &&
            (createdAt.get(node.id) ?? Number.POSITIVE_INFINITY) <= baseline &&
            templateHashes.has(templateHash(node)) &&
            !workerHistoryNodeIds.has(node.id) &&
            !briefOverrideNodeIds.has(node.id),
        )
        .sort(
          (left, right) =>
            (createdAt.get(left.id) ?? 0) - (createdAt.get(right.id) ?? 0) ||
            left.id.localeCompare(right.id),
        );
    return { events, state, baseline, templateHashes, eligibleNodes };
  }

  private seededTaskSuggestion(eligibleNodes: GraphNode[]): string {
    const titles = eligibleNodes.slice(0, 3).map((node) => canonicalizeTitle(node.title));
    return titles.length === 0
      ? ""
      : ` Seeded tasks that can still run live: ${titles.join(", ")}.`;
  }

  private requireEligible(projectId: string, requestedNodeId: string): GraphNode {
    const result = this.eligibility(projectId, requestedNodeId);
    if (result.eligible) return result.node;
    switch (result.code) {
      case "node_not_found":
        throw new FleetQueueError(404, "node_not_found", result.message);
      case "template_mismatch":
        throw new FleetQueueError(400, "template_mismatch", result.message);
      default:
        throw new FleetQueueError(400, "node_not_dispatched", result.message);
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
