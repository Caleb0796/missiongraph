import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { buildDigest } from "./digest.js";
import {
  EventStore,
  EventValidationError,
  CapabilityError,
  StaleSequenceError,
  UnknownProjectError,
  parseActor,
  parseEventInput,
  reporterEventTypes,
  type Actor,
  type Event,
  type EventInput,
  type HumanAction,
  type ImportedEvent,
  type ReporterActor,
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

function mutationSession(request: FastifyRequest): string | undefined {
  const sessionId = textHeader(request.headers["x-mg-session"]);
  if (sessionId === "") throw new EventValidationError("x-mg-session must not be empty");
  return sessionId;
}

function requiredMutationSession(request: FastifyRequest): string {
  const sessionId = mutationSession(request);
  if (!sessionId) throw new EventValidationError("x-mg-session is required");
  return sessionId;
}

function requiredBrowserSession(
  store: EventStore,
  request: FastifyRequest,
  project: string,
  at: string,
): string {
  const sessionId = requiredMutationSession(request);
  const proof = textHeader(request.headers["x-mg-session-proof"]);
  if (!proof || !store.browserSessionMatches(project, sessionId, proof, at)) {
    throw new CapabilityError("session_invalid", "The server-issued browser session is invalid or expired.");
  }
  return sessionId;
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

function valueHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function mutationSubject(body: Record<string, unknown>): string {
  return valueHash(body.batch === undefined
    ? { type: body.type, payload: body.payload }
    : { batch: body.batch });
}

function actionForTypes(types: readonly string[]): HumanAction | undefined {
  const actions = new Set(
    types.flatMap((type): HumanAction[] => {
      switch (type) {
        case "APPROVED": return ["approve"];
        case "REJECTED": return ["reject"];
        case "DISPATCHED": return ["dispatch"];
        case "PAUSE_REQUESTED": return ["pause"];
        case "RESUME_REQUESTED": return ["resume"];
        case "TASK_REMOVED":
        case "TASK_SPLIT":
        case "EDGE_REMOVED":
          return ["structural"];
        default:
          return [];
      }
    }),
  );
  if (actions.size > 1) throw new EventValidationError("one capability cannot authorize mixed action types");
  return [...actions][0];
}

function actionForMutation(
  inputs: readonly EventInput[],
  projectEvents: readonly Event[],
): HumanAction | undefined {
  const direct = actionForTypes(inputs.map((input) => input.type));
  if (direct) {
    const consequentialCount = inputs.filter((input) => actionForTypes([input.type]) !== undefined).length;
    if (direct !== "structural" && consequentialCount !== 1) {
      throw new EventValidationError("one capability cannot authorize multiple consequential actions");
    }
    return direct;
  }
  if (inputs.some((input) => input.type === "EDGE_ADDED")) {
    const state = fold(projectEvents);
    const touchesStartedWork = inputs.some((input) => {
      if (input.type !== "EDGE_ADDED") return false;
      return [input.payload.upstream, input.payload.downstream].some((nodeId) => {
        const node = state.nodes[nodeId];
        return Boolean(node && (node.ever_started || node.state !== "queued"));
      });
    });
    if (touchesStartedWork) return "structural";
  }
  return undefined;
}

function capabilityHeaders(request: FastifyRequest): {
  ref: string;
  token: string;
  nonce: string;
} {
  const ref = textHeader(request.headers["x-mg-capability-ref"]);
  const token = textHeader(request.headers["x-mg-capability"]);
  const nonce = textHeader(request.headers["x-mg-nonce"]);
  if (!ref || !token || !nonce) {
    throw new CapabilityError("capability_required", "Visible human confirmation is required for this action.");
  }
  return { ref, token, nonce };
}

const nodeScopedReporterEventTypes = new Set([
  "NODE_STATE_CHANGED",
  "PAUSE_ACKED",
  "WORKER_LOG",
  "HANDOFF_FILED",
  "DEVIATION_NOTED",
  "APPROVAL_CREATED",
]);

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
  if (error instanceof CapabilityError) {
    return reply.code(403).send({ error: { code: error.code, message: error.message } });
  }
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

function seedImport(value: unknown): ImportedEvent[] {
  const body = record(value, "body");
  if (body.v !== 1) throw new EventValidationError("v must be 1");
  if (!Array.isArray(body.events)) throw new EventValidationError("events must be an array");
  let sourceProject: string | undefined;
  return body.events.map((value, index) => {
    const event = record(value, `events[${index}]`);
    const allowedKeys = new Set(["seq", "project_id", "ts", "actor", "type", "payload", "idem_key"]);
    const unexpected = Object.keys(event).find((key) => !allowedKeys.has(key));
    if (unexpected) throw new EventValidationError(`events[${index}].${unexpected} is not an event field`);
    if (event.seq !== index + 1) {
      throw new EventValidationError(`events[${index}].seq must be ${index + 1}`);
    }
    if (typeof event.project_id !== "string" || event.project_id.length === 0) {
      throw new EventValidationError(`events[${index}].project_id must not be empty`);
    }
    sourceProject ??= event.project_id;
    if (event.project_id !== sourceProject) {
      throw new EventValidationError(`events[${index}].project_id does not match the stream`);
    }
    if (typeof event.ts !== "string" || !Number.isFinite(Date.parse(event.ts))) {
      throw new EventValidationError(`events[${index}].ts must be an ISO 8601 timestamp`);
    }
    return { input: parseEventInput(event), ts: event.ts };
  });
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
  const configuredSeedProjectId = options.seedProjectId ?? process.env.SEED_PROJECT_ID;
  const fixtureSeedProjectId = "demo-seed";
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
        "content-type, x-mg-token, x-mg-session, x-mg-session-proof, x-mg-capability-ref, x-mg-capability, x-mg-nonce",
      )
      .header("access-control-max-age", "86400");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.post("/api/p/:project/browser-sessions", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const createdAt = now();
      const session = store.issueBrowserSession({
        id: id(),
        token: id(),
        project_id: project,
        created_at: createdAt.toISOString(),
        expires_at: new Date(createdAt.getTime() + 12 * 60 * 60_000).toISOString(),
      });
      return reply.send({
        session_id: session.id,
        session_proof: session.token,
        expires_at: session.expires_at,
      });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/policy-drafts", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const body = record(request.body, "body");
      const createdAt = now();
      const sessionId = requiredBrowserSession(store, request, project, createdAt.toISOString());
      if (typeof body.text !== "string" || body.text.trim() === "") {
        throw new EventValidationError("text must not be empty");
      }
      const maxUses = body.max_uses === undefined ? 4 : body.max_uses;
      if (!Number.isSafeInteger(maxUses) || (maxUses as number) < 1 || (maxUses as number) > 20) {
        throw new EventValidationError("max_uses must be an integer between 1 and 20");
      }
      const draft = store.stageHumanDraft({
        id: id(),
        project_id: project,
        session_id: sessionId,
        kind: "policy",
        actions: ["approve", "reject"],
        subject_hash: valueHash(body.text),
        display_text: body.text,
        policy_text: body.text,
        max_uses: maxUses as number,
        created_at: createdAt.toISOString(),
        expires_at: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
      });
      return reply.send({
        draft_id: draft.id,
        project_id: draft.project_id,
        session_id: draft.session_id,
        text: draft.display_text,
        policy_hash: draft.subject_hash,
        scope: "session",
        allowed_actions: draft.actions,
        max_uses: draft.max_uses,
        created_at: draft.created_at,
        expires_at: draft.expires_at,
      });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/policy-drafts/:draft/confirm", async (request, reply) => {
    const { project, draft } = request.params as { project: string; draft: string };
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    const confirmedAt = now().toISOString();
    try {
      const sessionId = requiredBrowserSession(store, request, project, confirmedAt);
      const result = store.confirmPolicyDraft({
        projectId: project,
        sessionId,
        draftId: draft,
        confirmedAt,
        requestOrigin: textHeader(request.headers.origin) ?? "same-origin",
        token: id(),
      });
      return reply.send({
        policy_ref: result.capability.ref,
        capability: result.capability.token,
        allowed_actions: result.capability.actions,
        max_uses: result.capability.max_uses,
        expires_at: result.capability.expires_at,
        confirmed_at: result.capability.confirmed_at,
        seq: result.event.seq,
      });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/action-drafts", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const body = record(request.body, "body");
      const mutation = record(body.mutation, "mutation");
      const createdAt = now();
      const sessionId = requiredBrowserSession(store, request, project, createdAt.toISOString());
      let inputs: EventInput[];
      if (mutation.batch !== undefined) {
        if (!Array.isArray(mutation.batch) || mutation.batch.length === 0) {
          throw new EventValidationError("mutation.batch must be a non-empty array");
        }
        inputs = mutation.batch.map((item) => parseEventInput({ ...record(item, "mutation.batch item"), actor: "human", idem_key: id() }));
      } else {
        inputs = [parseEventInput({ ...mutation, actor: "human", idem_key: id() })];
      }
      const action = actionForMutation(inputs, store.listEvents(project));
      if (!action) throw new EventValidationError("mutation does not require human-presence confirmation");
      const displayText = typeof body.summary === "string" && body.summary.trim() !== ""
        ? body.summary
        : `Confirm ${action}`;
      const draftRecord = store.stageHumanDraft({
        id: id(),
        project_id: project,
        session_id: sessionId,
        kind: "action",
        actions: [action],
        subject_hash: mutationSubject(mutation),
        display_text: displayText,
        max_uses: 1,
        created_at: createdAt.toISOString(),
        expires_at: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
      });
      return reply.send({
        draft_id: draftRecord.id,
        project_id: draftRecord.project_id,
        session_id: draftRecord.session_id,
        action,
        summary: draftRecord.display_text,
        subject_hash: draftRecord.subject_hash,
        max_uses: 1,
        created_at: draftRecord.created_at,
        expires_at: draftRecord.expires_at,
      });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/action-drafts/:draft/confirm", async (request, reply) => {
    const { project, draft } = request.params as { project: string; draft: string };
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const confirmedAt = now().toISOString();
      const sessionId = requiredBrowserSession(store, request, project, confirmedAt);
      const capability = store.confirmHumanDraft({
        projectId: project,
        sessionId,
        draftId: draft,
        kind: "action",
        confirmedAt,
        requestOrigin: textHeader(request.headers.origin) ?? "same-origin",
        token: id(),
      });
      return reply.send({
        capability_ref: capability.ref,
        capability: capability.token,
        action: capability.actions[0],
        expires_at: capability.expires_at,
        confirmed_at: capability.confirmed_at,
      });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/human-drafts/:draft/deny", async (request, reply) => {
    const { project, draft } = request.params as { project: string; draft: string };
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      store.denyHumanDraft({
        projectId: project,
        sessionId: requiredBrowserSession(store, request, project, now().toISOString()),
        draftId: draft,
        deniedAt: now().toISOString(),
      });
      return reply.code(204).send();
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  const mutationHandler = (actor: Extract<Actor, "human" | "browser_agent">) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const project = (request.params as { project: string }).project;
      if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
      let baseSeq: number | undefined;
      try {
        const body = request.body as Record<string, unknown>;
        const sessionId = mutationSession(request);
        baseSeq = baseSequence(body);
        let inputs: EventInput[];
        let batchIdemKey: string | undefined;
        if (body.batch !== undefined) {
          const batch = batchInputs(body, actor, id);
          inputs = batch.inputs;
          batchIdemKey = batch.idemKey;
        } else {
          inputs = [parseEventInput({ ...body, actor })];
        }
        for (const input of inputs) {
          if (reporterEventTypes.has(input.type)) {
            throw new EventValidationError(`${input.type} must use the reporter endpoint`);
          }
          if (input.type === "POLICY_STATED") {
            throw new CapabilityError("capability_required", "Policies must be confirmed in the visible native UI.");
          }
        }
        const action = actionForMutation(inputs, store.listEvents(project));
        const subjectHash = (() => {
          if (action !== "approve" && action !== "reject") return mutationSubject(body);
          const approvalInput = inputs.find((input) => input.type === "APPROVED" || input.type === "REJECTED");
          const policyRef = approvalInput && "policy_ref" in approvalInput.payload
            ? approvalInput.payload.policy_ref
            : undefined;
          if (!policyRef) return mutationSubject(body);
          const policy = fold(store.listEvents(project)).policies[policyRef];
          return valueHash(policy?.text ?? "");
        })();
        let audit: ReturnType<EventStore["consumeHumanCapability"]> | undefined;
        const authorize = action
          ? () => {
              const headers = capabilityHeaders(request);
              if (action === "approve" || action === "reject") {
                const approvalInput = inputs.find(
                  (input) => input.type === "APPROVED" || input.type === "REJECTED",
                );
                const policyRef = approvalInput && "policy_ref" in approvalInput.payload
                  ? approvalInput.payload.policy_ref
                  : undefined;
                if (policyRef !== headers.ref) {
                  throw new EventValidationError(
                    "payload.policy_ref must match the confirmed policy capability",
                  );
                }
              }
              const verifiedSessionId = requiredBrowserSession(
                store,
                request,
                project,
                now().toISOString(),
              );
              audit = store.consumeHumanCapability({
                projectId: project,
                sessionId: verifiedSessionId,
                ...headers,
                action,
                subjectHash,
                usedAt: now().toISOString(),
              });
              const authorization = {
                capability_ref: audit.ref,
                ...(audit.policy_text ? { policy_text: audit.policy_text } : {}),
                confirmed_at: audit.confirmed_at,
                request_origin: audit.request_origin,
                use_nonce: audit.use_nonce,
              };
              for (const input of inputs) {
                switch (input.type) {
                  case "TASK_REMOVED":
                  case "TASK_SPLIT":
                  case "EDGE_ADDED":
                  case "EDGE_REMOVED":
                  case "DISPATCHED":
                  case "PAUSE_REQUESTED":
                  case "RESUME_REQUESTED":
                  case "APPROVED":
                  case "REJECTED":
                    input.payload.authorization = authorization;
                    if (input.type === "APPROVED" || input.type === "REJECTED") {
                      input.payload.policy_ref = audit.ref;
                    }
                }
              }
            }
          : undefined;
        if (batchIdemKey) {
          const result = store.appendBatch(project, inputs, batchIdemKey, {
            ...(baseSeq === undefined ? {} : { baseSeq }),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(authorize ? { authorize } : {}),
            ts: now().toISOString(),
          });
          return reply.send({ seqs: result.events.map((event) => event.seq) });
        }
        const result = store.append(project, inputs[0]!, {
          ...(baseSeq === undefined ? {} : { baseSeq }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(authorize ? { authorize } : {}),
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
    };

  app.post("/api/p/:project/mutations", mutationHandler("human"));
  app.post("/api/p/:project/agent-mutations", mutationHandler("browser_agent"));

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
      const payloadNodeId = "node_id" in input.payload ? input.payload.node_id : undefined;
      if (
        projectIdentity?.actor.startsWith("worker:") &&
        nodeScopedReporterEventTypes.has(input.type) &&
        payloadNodeId !== projectIdentity.actor.slice("worker:".length)
      ) {
        return reply.code(403).send({ error: "worker credential is bound to a different node" });
      }
      if (!reporterEventTypes.has(input.type) && !(input.actor === "supervisor" && input.type === "JOURNAL_NOTE")) {
        throw new EventValidationError(`${input.type} is not a fleet reporter event`);
      }
      const result = store.append(project, input, { ts: reportTime.toISOString() });
      return reply.send({ seq: result.event.seq });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/p/:project/reporter-credentials", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    const authorization = textHeader(request.headers.authorization);
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!sameSecret(bearer, supervisorReporterToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      const body = record(request.body, "body");
      const actor = parseActor(body.actor);
      if (actor !== "supervisor" && !actor.startsWith("worker:")) {
        throw new EventValidationError("actor must be supervisor or worker:<node_id>");
      }
      if (actor.startsWith("worker:")) {
        const nodeId = actor.slice("worker:".length);
        const state = fold(store.listEvents(project));
        if (!state.nodes[nodeId]) {
          return reply.code(404).send({ error: { code: "node_not_found", message: `node ${nodeId} does not exist` } });
        }
      }
      const credential = store.issueReporterCredential(
        project,
        actor as ReporterActor,
        now().toISOString(),
      );
      return reply.send({
        token: credential.token,
        actor: credential.actor,
        expires: credential.expires_at,
      });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.get("/api/health", async (_request, reply) => {
    return reply.send({ ok: true });
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

  app.get("/api/p/:project/export", async (request, reply) => {
    const project = (request.params as { project: string }).project;
    if (!visitorAuthorized(store, request, project)) return reply.code(401).send({ error: "unauthorized" });
    try {
      return reply.send({ v: 1, events: store.listEvents(project) });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/import-seed", async (request, reply) => {
    const authorization = textHeader(request.headers.authorization);
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!sameSecret(bearer, supervisorReporterToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      const imported = seedImport(request.body);
      const project = id();
      const token = id();
      const created = now().toISOString();
      store.importProject(project, token, created, imported, { reporterToken: id() });
      return reply.send({ project_id: project, token, cursor: String(imported.length) });
    } catch (error) {
      return errorReply(error, reply);
    }
  });

  app.post("/api/clone-demo", async (_request, reply) => {
    const project = id();
    const token = id();
    const created = now();
    try {
      let sourceProjectId = fixtureSeedProjectId;
      if (configuredSeedProjectId) {
        if (store.hasProject(configuredSeedProjectId)) {
          sourceProjectId = configuredSeedProjectId;
        } else {
          app.log.warn(
            { seedProjectId: configuredSeedProjectId },
            "Configured seed project is missing; falling back to the built-in fixture seed",
          );
        }
      }
      const source = store.hasProject(sourceProjectId) ? store.listEvents(sourceProjectId) : [];
      store.createProject(project, token, created.toISOString(), {
        seedProjectId: sourceProjectId,
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
