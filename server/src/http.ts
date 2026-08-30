import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { buildDigest } from "./digest.js";
import {
  EventStore,
  EventValidationError,
  StaleSequenceError,
  UnknownProjectError,
  parseActor,
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

function baseSequence(body: Record<string, unknown>): number | undefined {
  if (body.base_seq === undefined) return undefined;
  if (!Number.isSafeInteger(body.base_seq) || (body.base_seq as number) < 0) {
    throw new EventValidationError("base_seq must be a non-negative integer");
  }
  return body.base_seq as number;
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
  const firstTime = events[0] ? Date.parse(events[0].ts) : now.getTime();
  return events.map((event) => ({
    input: parseEventInput({
      actor: event.actor,
      type: event.type,
      payload: remapPayload(event.payload, ids),
      idem_key: randomUUID(),
    }),
    ts: new Date(now.getTime() + Math.max(0, Date.parse(event.ts) - firstTime)).toISOString(),
  }));
}

export function createServer(options: ServerOptions = {}): MissionGraphServer {
  const reporterToken = options.reporterToken ?? process.env.REPORTER_TOKEN;
  if (!reporterToken) throw new Error("REPORTER_TOKEN is required");
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const seedProjectId = options.seedProjectId ?? process.env.SEED_PROJECT_ID ?? "demo-seed";
  const store = new EventStore(options.databasePath ?? process.env.DB_PATH ?? "missiongraph.sqlite");
  const app = Fastify({ logger: options.logger ?? false });

  app.post("/api/p/:project/mutations", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    let baseSeq: number | undefined;
    try {
      const body = request.body as Record<string, unknown>;
      const actor = mutationActor(request);
      const input = parseEventInput({ ...body, actor });
      if (reporterEventTypes.has(input.type)) {
        throw new EventValidationError(`${input.type} must use the reporter endpoint`);
      }
      baseSeq = baseSequence(body);
      const result = store.append(project, input, {
        ...(baseSeq === undefined ? {} : { baseSeq }),
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
    if (!sameSecret(bearer, reporterToken)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const input = parseEventInput(request.body);
      if (input.actor !== "supervisor" && !input.actor.startsWith("worker:")) {
        throw new EventValidationError("reporter actor must be supervisor or worker:<id>");
      }
      if (!reporterEventTypes.has(input.type)) {
        throw new EventValidationError(`${input.type} is not a fleet reporter event`);
      }
      const result = store.append(project, input, { ts: now().toISOString() });
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
      store.createProject(project, token, created.toISOString(), seedProjectId);
      for (const clone of cloneInputs(source, created)) store.append(project, clone.input, { ts: clone.ts });
      const state = fold(store.listEvents(project));
      for (const current of Object.values(state.nodes).filter((node) => node.state === "running")) {
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
