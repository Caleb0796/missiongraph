import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const lifecycleTypes = new Set([
  "NODE_STATE_CHANGED",
  "PAUSE_ACKED",
  "WORKER_LOG",
  "HANDOFF_FILED",
  "DEVIATION_NOTED",
  "APPROVAL_CREATED",
]);

function templateHash(title, brief) {
  return createHash("sha256").update(`${title}\n${brief}`).digest("hex");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function empty(response, status = 204) {
  response.writeHead(status);
  response.end();
}

function fleetError(response, status, code, message = code) {
  json(response, status, { error: { code, message } });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicRequest(request) {
  return {
    id: request.id,
    status: request.status,
    ...(request.status === "queued" ? { position: request.position } : {}),
    ...(request.adopted_at ? { adopted_at: new Date(request.adopted_at).toISOString() } : {}),
    ...(request.finished_at ? { finished_at: new Date(request.finished_at).toISOString() } : {}),
    ...(request.outcome ? { outcome: request.outcome } : {}),
  };
}

export async function startFleetStub({
  enabled = true,
  dailyCap = 30,
  perProjectCap = 1,
  ttlMin = 20,
} = {}) {
  const reporterToken = `stub-supervisor-${randomUUID()}`;
  const projects = new Map();
  const requests = new Map();
  const browserSessions = new Map();
  const drafts = new Map();
  const capabilities = new Map();
  const workerCredentials = new Map();
  const seedTemplates = [
    { title: "Fleet template A", brief: "Execute the first bounded fleet template.", estimate_min: 1 },
    { title: "Fleet template B", brief: "Execute the second bounded fleet template.", estimate_min: 1 },
    { title: "Fleet template C", brief: "Execute the third bounded fleet template.", estimate_min: 1 },
  ];
  let nowMs = Date.parse("2026-08-31T12:00:00.000Z");
  let sequence = 0;

  function append(project, actor, type, payload, idemKey = randomUUID()) {
    const event = {
      seq: ++sequence,
      project_id: project.id,
      ts: new Date(nowMs).toISOString(),
      actor,
      type,
      payload,
      idem_key: idemKey,
    };
    project.events.push(event);
    return event;
  }

  const seedProject = {
    id: `seed-${randomUUID()}`,
    token: `visitor-${randomUUID()}`,
    nodes: new Map(),
    events: [],
  };
  seedTemplates.forEach((template, index) => {
    const node = {
      id: `seed-node-${index + 1}-${randomUUID()}`,
      ...template,
      tags: ["fleet-template"],
      state: "queued",
      record_type: "task",
      availability: "ready",
      assigned: false,
    };
    seedProject.nodes.set(node.id, node);
    append(seedProject, "human", "TASK_ADDED", {
      node: {
        id: node.id,
        title: node.title,
        brief: node.brief,
        estimate_min: node.estimate_min,
        tags: node.tags,
        state: node.state,
      },
    });
  });
  projects.set(seedProject.id, seedProject);

  function cloneProject() {
    const id = `clone-${randomUUID()}`;
    const token = `visitor-${randomUUID()}`;
    const project = { id, token, nodes: new Map(), events: [] };
    [...seedProject.nodes.values()].forEach((template, index) => {
      const node = {
        ...template,
        id: `clone-node-${index + 1}-${randomUUID()}`,
        tags: ["fleet-template"],
        state: "queued",
        record_type: "task",
        availability: "ready",
        assigned: false,
      };
      project.nodes.set(node.id, node);
      append(project, "human", "TASK_ADDED", {
        node: {
          id: node.id,
          title: node.title,
          brief: node.brief,
          estimate_min: node.estimate_min,
          tags: node.tags,
          state: node.state,
        },
      });
    });
    projects.set(id, project);
    return project;
  }

  function dailyUsed() {
    const at = new Date(nowMs);
    const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    const end = start + 24 * 60 * 60_000;
    return [...requests.values()].filter((item) => item.created_at >= start && item.created_at < end).length;
  }

  function eligibility(project, nodeId) {
    const node = project?.nodes.get(nodeId);
    if (!node || node.record_type !== "task") {
      return { eligible: false, code: "node_not_found", message: `Node ${nodeId} does not exist.` };
    }
    if (project.id === seedProject.id) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: "The seed template project itself is not fleet-eligible.",
      };
    }
    const hasWorkerLifecycle = project.events.some(
      (event) => lifecycleTypes.has(event.type) && event.payload?.node_id === nodeId,
    );
    if (node.state !== "queued" || !node.assigned || hasWorkerLifecycle) {
      return {
        eligible: false,
        code: "node_not_dispatched",
        message: "The node is not dispatched or already has worker events.",
      };
    }
    const hasBriefOverride = project.events.some(
      (event) => event.type === "DISPATCHED" && event.payload?.node_id === nodeId && event.payload.brief_override !== undefined,
    );
    if (hasBriefOverride) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: "A DISPATCHED brief_override is not fleet-eligible; dispatch the canonical template title and brief.",
      };
    }
    const requestedHash = templateHash(node.title, node.brief);
    const matchesTemplate = [...seedProject.nodes.values()].some(
      (template) => template.record_type === "task" && templateHash(template.title, template.brief) === requestedHash,
    );
    if (!matchesTemplate) {
      return {
        eligible: false,
        code: "template_mismatch",
        message: "The node does not match the seed template registry.",
      };
    }
    return { eligible: true, node };
  }

  function supervisorAuthorized(request) {
    return request.headers["x-mg-reporter"] === reporterToken;
  }

  function sweep() {
    const ttlMs = ttlMin * 60_000;
    for (const request of requests.values()) {
      if (
        (request.status === "adopted" || request.status === "running") &&
        request.adopted_at !== undefined &&
        nowMs - request.adopted_at >= ttlMs
      ) {
        request.status = "expired";
        request.finished_at = nowMs;
      }
    }
    let position = 0;
    for (const request of [...requests.values()].sort((left, right) => left.order - right.order)) {
      if (request.status === "queued") request.position = ++position;
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://stub.invalid");
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "POST" && url.pathname === "/api/clone-demo") {
        const project = cloneProject();
        return json(response, 200, { project: project.id, token: project.token, cursor: String(project.events.at(-1)?.seq ?? 0) });
      }

      if (parts[0] === "api" && parts[1] === "p" && parts[2]) {
        const projectId = decodeURIComponent(parts[2]);
        const project = projects.get(projectId);
        const bearerRoute = parts[3] === "reporter-credentials" || parts[3] === "report";
        if (!project || (!bearerRoute && request.headers["x-mg-token"] !== project.token)) {
          return json(response, 401, { error: "unauthorized" });
        }

        if (request.method === "GET" && parts[3] === "snapshot") {
          return json(response, 200, {
            state: { nodes: Object.fromEntries([...project.nodes].map(([id, node]) => [id, { ...node }])) },
            cursor: String(project.events.at(-1)?.seq ?? 0),
          });
        }
        if (request.method === "GET" && parts[3] === "export") {
          return json(response, 200, { v: 1, events: project.events });
        }
        if (request.method === "POST" && parts[3] === "browser-sessions") {
          const session = { id: randomUUID(), proof: randomUUID(), project_id: project.id };
          browserSessions.set(session.id, session);
          return json(response, 200, {
            session_id: session.id,
            session_proof: session.proof,
            expires_at: new Date(nowMs + 12 * 60 * 60_000).toISOString(),
          });
        }
        if (request.method === "POST" && parts[3] === "action-drafts" && parts.length === 4) {
          const session = browserSessions.get(request.headers["x-mg-session"]);
          if (!session || session.project_id !== project.id || request.headers["x-mg-session-proof"] !== session.proof) {
            return fleetError(response, 403, "session_invalid");
          }
          const body = await requestBody(request);
          const draft = { id: randomUUID(), project_id: project.id, session_id: session.id, mutation: body.mutation };
          drafts.set(draft.id, draft);
          return json(response, 200, {
            draft_id: draft.id,
            project_id: project.id,
            session_id: session.id,
            action: "dispatch",
            summary: body.summary,
            subject_hash: templateHash("draft", JSON.stringify(body.mutation)),
            max_uses: 1,
            created_at: new Date(nowMs).toISOString(),
            expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
          });
        }
        if (request.method === "POST" && parts[3] === "action-drafts" && parts[5] === "confirm") {
          const draft = drafts.get(decodeURIComponent(parts[4]));
          const session = browserSessions.get(request.headers["x-mg-session"]);
          if (!draft || !session || draft.project_id !== project.id || request.headers["x-mg-session-proof"] !== session.proof) {
            return fleetError(response, 403, "capability_invalid");
          }
          const capability = randomUUID();
          const ref = randomUUID();
          capabilities.set(ref, { token: capability, project_id: project.id, mutation: draft.mutation, used: false });
          return json(response, 200, {
            capability_ref: ref,
            capability,
            action: "dispatch",
            expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
            confirmed_at: new Date(nowMs).toISOString(),
          });
        }
        if (request.method === "POST" && parts[3] === "mutations") {
          const body = await requestBody(request);
          if (body.type === "DISPATCHED") {
            const capability = capabilities.get(request.headers["x-mg-capability-ref"]);
            if (!capability || capability.used || capability.project_id !== project.id || capability.token !== request.headers["x-mg-capability"]) {
              return fleetError(response, 403, "capability_required");
            }
            capability.used = true;
            const node = project.nodes.get(body.payload?.node_id);
            if (!node) return fleetError(response, 400, "invalid_event", "unknown dispatch node");
            node.assigned = true;
            const event = append(project, "human", "DISPATCHED", body.payload, body.idem_key);
            return json(response, 200, { seq: event.seq });
          }
          if (body.type === "TASK_ADDED") {
            const input = body.payload?.node;
            const node = {
              ...input,
              record_type: "task",
              availability: "ready",
              assigned: false,
            };
            project.nodes.set(node.id, node);
            const event = append(project, "human", "TASK_ADDED", body.payload, body.idem_key);
            return json(response, 200, { seq: event.seq });
          }
          return fleetError(response, 400, "invalid_event");
        }
        if (request.method === "POST" && parts[3] === "reporter-credentials") {
          if (request.headers.authorization !== `Bearer ${reporterToken}`) return json(response, 401, { error: "unauthorized" });
          const body = await requestBody(request);
          const token = `worker-credential-${randomUUID()}`;
          workerCredentials.set(token, { project_id: project.id, actor: body.actor });
          return json(response, 200, { token, actor: body.actor, expires: new Date(nowMs + 15 * 60_000).toISOString() });
        }
        if (request.method === "POST" && parts[3] === "report") {
          const bearer = request.headers.authorization?.startsWith("Bearer ")
            ? request.headers.authorization.slice("Bearer ".length)
            : undefined;
          const credential = workerCredentials.get(bearer);
          const body = await requestBody(request);
          const supervisor = bearer === reporterToken && body.actor === "supervisor";
          if (!supervisor && (!credential || credential.project_id !== project.id || credential.actor !== body.actor)) {
            return json(response, 401, { error: "unauthorized" });
          }
          const event = append(project, body.actor, body.type, body.payload, body.idem_key);
          return json(response, 200, { seq: event.seq });
        }
        if (request.method === "GET" && parts[3] === "fleet-status") {
          if (!enabled) return json(response, 200, { enabled: false, queue_depth: 0, daily_remaining: 0, project_remaining: 0 });
          sweep();
          const projectUsed = [...requests.values()].filter((item) => item.project_id === project.id && item.status !== "expired").length;
          return json(response, 200, {
            enabled: true,
            queue_depth: [...requests.values()].filter((item) => item.status === "queued").length,
            daily_remaining: Math.max(0, dailyCap - dailyUsed()),
            project_remaining: Math.max(0, perProjectCap - projectUsed),
          });
        }
        if (parts[3] === "fleet-requests") {
          if (!enabled) return fleetError(response, 404, "fleet_disabled");
          sweep();
          if (request.method === "POST" && parts.length === 4) {
            const body = await requestBody(request);
            const result = eligibility(project, body.node_id);
            if (!result.eligible) {
              const status = result.code === "node_not_found" ? 404 : 400;
              return fleetError(response, status, result.code, result.message);
            }
            if ([...requests.values()].some(
              (item) => item.project_id === project.id && item.node_id === result.node.id && item.status !== "expired",
            )) {
              return fleetError(response, 409, "fleet_request_exists");
            }
            const projectUsed = [...requests.values()].filter((item) => item.project_id === project.id && item.status !== "expired").length;
            if (projectUsed >= perProjectCap) return fleetError(response, 429, "fleet_project_cap");
            if (dailyUsed() >= dailyCap) return fleetError(response, 429, "fleet_daily_cap");
            const item = {
              id: `fleet-request-${randomUUID()}`,
              project_id: project.id,
              node_id: result.node.id,
              status: "queued",
              created_at: nowMs,
              order: requests.size + 1,
            };
            requests.set(item.id, item);
            sweep();
            return json(response, 200, { id: item.id, status: "queued", position: item.position });
          }
          if (request.method === "GET" && parts[4]) {
            const item = requests.get(decodeURIComponent(parts[4]));
            if (!item || item.project_id !== project.id) return fleetError(response, 404, "fleet_request_not_found");
            return json(response, 200, publicRequest(item));
          }
        }
      }

      if (parts[0] === "api" && parts[1] === "fleet") {
        if (!enabled) return fleetError(response, 404, "fleet_disabled");
        if (!supervisorAuthorized(request)) return json(response, 401, { error: "unauthorized" });
        sweep();
        if (request.method === "POST" && parts[2] === "next") {
          while (true) {
            const item = [...requests.values()]
              .filter((candidate) => candidate.status === "queued")
              .sort((left, right) => left.order - right.order)[0];
            if (!item) return empty(response);
            const project = projects.get(item.project_id);
            const result = eligibility(project, item.node_id);
            if (!result.eligible) {
              item.status = "failed";
              item.outcome = result.code === "template_mismatch" ? result.code : "stale";
              item.note = result.message;
              item.finished_at = nowMs;
              continue;
            }
            item.status = "adopted";
            item.adopted_at = nowMs;
            sweep();
            return json(response, 200, {
              request_id: item.id,
              project_id: project.id,
              node_id: result.node.id,
              node: { title: result.node.title, brief: result.node.brief, estimate: result.node.estimate_min },
              visitor_token: project.token,
            });
          }
        }
        const item = requests.get(decodeURIComponent(parts[2] ?? ""));
        if (!item) return fleetError(response, 404, "fleet_request_not_found");
        if (request.method === "POST" && parts[3] === "heartbeat") {
          if (item.status === "adopted") item.status = "running";
          if (item.status !== "running") return fleetError(response, 409, "fleet_request_not_active");
          item.adopted_at = nowMs;
          return json(response, 200, { id: item.id, status: item.status });
        }
        if (request.method === "POST" && parts[3] === "complete") {
          if (item.status !== "adopted" && item.status !== "running") return fleetError(response, 409, "fleet_request_not_active");
          const body = await requestBody(request);
          item.status = body.outcome;
          item.outcome = body.outcome;
          item.note = body.note;
          item.finished_at = nowMs;
          return json(response, 200, { id: item.id, status: item.status, outcome: item.outcome });
        }
      }

      fleetError(response, 404, "not_found");
    } catch (error) {
      fleetError(response, 500, "stub_error", error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    reporterToken,
    seedProject: { project: seedProject.id, token: seedProject.token },
    advance(ms) {
      nowMs += ms;
    },
    addSeedTemplate({ title, brief, estimate_min = 1 }) {
      const node = {
        id: `seed-node-${randomUUID()}`,
        title,
        brief,
        estimate_min,
        tags: ["fleet-template"],
        state: "queued",
        record_type: "task",
        availability: "ready",
        assigned: false,
      };
      seedProject.nodes.set(node.id, node);
      append(seedProject, "human", "TASK_ADDED", {
        node: {
          id: node.id,
          title: node.title,
          brief: node.brief,
          estimate_min: node.estimate_min,
          tags: node.tags,
          state: node.state,
        },
      });
      return node.id;
    },
    removeSeedTemplate(nodeId) {
      if (!seedProject.nodes.delete(nodeId)) throw new Error("cannot remove unknown stub seed node");
      append(seedProject, "human", "TASK_REMOVED", { node_id: nodeId, tombstone: true });
    },
    setNode(projectId, nodeId, changes) {
      const node = projects.get(projectId)?.nodes.get(nodeId);
      if (!node) throw new Error("cannot change unknown stub node");
      Object.assign(node, changes);
    },
    invalidate(projectId, nodeId) {
      const project = projects.get(projectId);
      const node = project?.nodes.get(nodeId);
      if (!project || !node) throw new Error("cannot invalidate unknown stub node");
      append(project, `worker:${nodeId}`, "WORKER_LOG", { node_id: nodeId, lines: ["invalidated before claim"] });
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
