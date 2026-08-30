import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { buildDigest } from "./digest.js";
import {
  EventStore,
  EventValidationError,
  StaleSequenceError,
  UnknownProjectError,
  parseEventInput,
  reporterEventTypes,
  type Actor,
  type Event,
  type EventInput,
} from "./events.js";
import { fold, GraphValidationError } from "./reducer.js";
import { installRealtime } from "./ws.js";

export interface ServerOptions {
  databasePath?: string;
  reporterToken?: string;
  seedProjectId?: string;
  now?: () => Date;
  id?: () => string;
  allowedOrigins?: string[];
  logger?: boolean;
}

export interface MissionGraphServer {
  app: FastifyInstance;
  store: EventStore;
}

function textHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function visitorAuthorized(store: EventStore, request: FastifyRequest, project: string): boolean {
  return store.tokenMatches(project, textHeader(request.headers["x-mg-token"]) ?? "");
}

function mutationActor(request: FastifyRequest): Actor {
  const raw = textHeader(request.headers["x-mg-actor"]);
  if (raw === undefined || raw === "human") return "human";
  if (raw === "browser_agent") return "browser_agent";
  throw new EventValidationError("x-mg-actor must be human or browser_agent");
}

function mutationSession(request: FastifyRequest): string | undefined {
  const sessionId = textHeader(request.headers["x-mg-session"]);
  if (sessionId === "") throw new EventValidationError("x-mg-session must not be empty");
  return sessionId;
}

function baseSequence(body: Record<string, unknown>): number | undefined {
  if (body.base_seq === undefined) return undefined;
  if (!Number.isSafeInteger(body.base_seq) || (body.base_seq as number) < 0) {
    throw new EventValidationError("base_seq must be a non-negative integer");
  }
  return body.base_seq as number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function batchInputs(
  body: Record<string, unknown>,
  actor: Actor,
  assignId: () => string,
): { idemKey: string; inputs: EventInput[] } {
  if (!Array.isArray(body.batch) || body.batch.length === 0) {
    throw new EventValidationError("batch must be a non-empty array");
  }
  if (body.batch.length > 500) throw new EventValidationError("batch must contain at most 500 events");
  if (typeof body.idem_key !== "string" || body.idem_key.length === 0) {
    throw new EventValidationError("idem_key must not be empty");
  }
  const tempIds = new Set<string>();
  const declare = (value: unknown, label: string): void => {
    if (typeof value !== "string" || value.length === 0) {
      throw new EventValidationError(`${label} must not be empty`);
    }
    if (tempIds.has(value)) throw new EventValidationError(`batch-local id ${value} is declared twice`);
    tempIds.add(value);
  };
  for (const [index, value] of body.batch.entries()) {
    const item = record(value, `batch[${index}]`);
    const payload = record(item.payload, `batch[${index}].payload`);
    if (item.type === "TASK_ADDED") {
      declare(record(payload.node, `batch[${index}].payload.node`).id, `batch[${index}].payload.node.id`);
    } else if (item.type === "EDGE_ADDED") {
      declare(payload.edge_id, `batch[${index}].payload.edge_id`);
    } else if (item.type === "TASK_SPLIT") {
      if (!Array.isArray(payload.children)) {
        throw new EventValidationError(`batch[${index}].payload.children must be an array`);
      }
      for (const [childIndex, child] of payload.children.entries()) {
        declare(
          record(child, `batch[${index}].payload.children[${childIndex}]`).id,
          `batch[${index}].payload.children[${childIndex}].id`,
        );
      }
    }
  }
  const ids = new Map([...tempIds].map((tempId) => [tempId, assignId()]));
  const inputs = body.batch.map((value, index) => {
    const item = record(value, `batch[${index}]`);
    return parseEventInput({
      ...item,
      actor,
      payload: remapPayload(item.payload, ids),
      idem_key: `${body.idem_key}:${index}`,
    });
  });
  return { idemKey: body.idem_key, inputs };
}

function errorReply(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof EventValidationError || error instanceof GraphValidationError) {
    return reply.code(400).send({ error: { code: "invalid_event", message: error.message } });
  }
  if (error instanceof UnknownProjectError) {
    return reply.code(404).send({ error: { code: "project_not_found", message: error.message } });
  }
  throw error;
}

function collectIds(events: readonly Event[]): Map<string, string> {
  const ids = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [childKey, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        [
          "id",
          "node_id",
          "parent_id",
          "new_target",
          "upstream",
          "downstream",
          "edge_id",
          "approval_id",
          "policy_ref",
          "session_id",
          "client_id",
          "target_id",
        ].includes(childKey)
      ) {
        ids.add(child);
      } else if (childKey === "selected" && Array.isArray(child)) {
        for (const selected of child) if (typeof selected === "string") ids.add(selected);
      } else {
        visit(child, childKey);
      }
    }
  };
  for (const event of events) visit(event.payload);
  return new Map([...ids].sort().map((id) => [id, randomUUID()]));
}

function remapPayload(value: unknown, ids: ReadonlyMap<string, string>, key?: string): unknown {
  if (Array.isArray(value)) {
    if (key === "selected") return value.map((item) => (typeof item === "string" ? ids.get(item) ?? item : item));
    return value.map((item) => remapPayload(item, ids, key));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => {
      if (
        typeof child === "string" &&
        [
          "id",
          "node_id",
          "parent_id",
          "new_target",
          "upstream",
          "downstream",
          "edge_id",
          "approval_id",
          "policy_ref",
          "session_id",
          "client_id",
          "target_id",
        ].includes(childKey)
      ) {
        return [childKey, ids.get(child) ?? child];
      }
      return [childKey, remapPayload(child, ids, childKey)];
    }),
  );
}

function cloneInputs(events: readonly Event[], now: Date): { input: EventInput; ts: string }[] {
  const ids = collectIds(events);
  const latestTime = events.at(-1) ? Date.parse(events.at(-1)!.ts) : now.getTime();
  return events.filter((event) => event.type !== "POLICY_STATED").map((event) => ({
    input: parseEventInput({
      actor: event.actor,
      type: event.type,
      payload: remapPayload(event.payload, ids),
      idem_key: randomUUID(),
    }),
    ts: new Date(now.getTime() + Date.parse(event.ts) - latestTime).toISOString(),
  }));
}

export function createServer(options: ServerOptions = {}): MissionGraphServer {
  const supervisorReporterToken = options.reporterToken ?? process.env.REPORTER_TOKEN;
  if (!supervisorReporterToken) throw new Error("REPORTER_TOKEN is required");
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const seedProjectId = options.seedProjectId ?? process.env.SEED_PROJECT_ID ?? "demo-seed";
  const allowedOrigins = new Set(
    options.allowedOrigins ??
      (process.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
  );
  const store = new EventStore(options.databasePath ?? process.env.DB_PATH ?? "missiongraph.sqlite");
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onRequest", async (request, reply) => {
    const origin = textHeader(request.headers.origin);
    if (!origin || !allowedOrigins.has(origin)) return;
    reply
      .header("access-control-allow-origin", origin)
      .header("vary", "Origin")
      .header("access-control-allow-methods", "GET, POST, OPTIONS")
      .header(
        "access-control-allow-headers",
        "content-type, x-mg-token, x-mg-session, x-mg-actor",
      )
      .header("access-control-max-age", "86400");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.post("/api/p/:project/mutations", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    let baseSeq: number | undefined;
    try {
      const body = request.body as Record<string, unknown>;
      const actor = mutationActor(request);
      const sessionId = mutationSession(request);
      baseSeq = baseSequence(body);
      if (body.batch !== undefined) {
        const batch = batchInputs(body, actor, id);
        for (const input of batch.inputs) {
          if (reporterEventTypes.has(input.type)) {
            throw new EventValidationError(`${input.type} must use the reporter endpoint`);
          }
        }
        const result = store.appendBatch(project, batch.inputs, batch.idemKey, {
          ...(baseSeq === undefined ? {} : { baseSeq }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ts: now().toISOString(),
        });
        return reply.send({ seqs: result.events.map((event) => event.seq) });
      }
      const input = parseEventInput({ ...body, actor });
      if (reporterEventTypes.has(input.type)) {
        throw new EventValidationError(`${input.type} must use the reporter endpoint`);
      }
      const result = store.append(project, input, {
        ...(baseSeq === undefined ? {} : { baseSeq }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ts: now().toISOString(),
      });
      return reply.send({ seq: result.event.seq });
    } catch (error) {
      if (error instanceof StaleSequenceError) {
        const events = store.listEvents(project);
        return reply.code(409).send({ fresh_digest: buildDigest(fold(events), events, baseSeq ?? 0) });
      }
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/report", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    const authorization = textHeader(request.headers.authorization);
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    const reportTime = now();
    const projectIdentity = bearer
      ? store.authenticateReporter(project, bearer, reportTime.toISOString())
      : undefined;
    const supervisorAuthorized = sameSecret(bearer, supervisorReporterToken);
    if (!projectIdentity && !supervisorAuthorized) return reply.code(401).send({ error: "unauthorized" });
    try {
      const input = parseEventInput(request.body);
      if (input.actor !== "supervisor" && !input.actor.startsWith("worker:")) {
        throw new EventValidationError("reporter actor must be supervisor or worker:<id>");
      }
      if (projectIdentity ? projectIdentity.actor !== input.actor : input.actor !== "supervisor") {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!reporterEventTypes.has(input.type)) {
        throw new EventValidationError(`${input.type} is not a fleet reporter event`);
      }
      const result = store.append(project, input, { ts: reportTime.toISOString() });
      return reply.send({ seq: result.event.seq });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.get("/api/p/:project/snapshot", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const events = store.listEvents(project);
      return reply.send({ state: fold(events), cursor: String(events.at(-1)?.seq ?? 0) });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/clone-demo", async (_request, reply) => {
    const project = id();
    const token = id();
    const created = now();
    try {
      const source = store.hasProject(seedProjectId) ? store.listEvents(seedProjectId) : [];
      store.createProject(project, token, created.toISOString(), {
        seedProjectId,
        reporterToken: id(),
      });
      for (const clone of cloneInputs(source, created)) {
        store.append(project, clone.input, { ts: clone.ts, trustedImport: true });
      }
      const state = fold(store.listEvents(project));
      for (const current of Object.values(state.nodes).filter(
        (node) => node.record_type === "task" && node.state === "running",
      )) {
        store.append(
          project,
          {
            actor: "supervisor",
            type: "NODE_STATE_CHANGED",
            payload: {
              node_id: current.id,
              from: "running",
              to: "paused",
              detail: "worker detached during visitor clone",
            },
            idem_key: id(),
          },
          { ts: now().toISOString() },
        );
      }
      return reply.send({ project, token, cursor: String(store.latestSeq(project)) });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  installRealtime(app, store);
  app.addHook("onClose", async () => store.close());
  return { app, store };
}

async function main(): Promise<void> {
  const { app } = createServer({ logger: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: "0.0.0.0", port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
