import { once } from "node:events";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer, type MissionGraphServer, type ServerOptions } from "../src/http.js";
import { baseHandoff } from "./fixtures.js";

const openServers: MissionGraphServer[] = [];

function server(options: ServerOptions = {}): MissionGraphServer {
  const result = createServer({ databasePath: ":memory:", reporterToken: "reporter-secret", ...options });
  openServers.push(result);
  return result;
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()?.app.close();
});

function seedPendingApproval(
  store: MissionGraphServer["store"],
  project: string,
  nodeId: string,
  approvalId = `approval-${nodeId}`,
) {
  store.append(project, {
    actor: "human",
    type: "TASK_ADDED",
    payload: {
      node: {
        id: nodeId,
        title: `Task ${nodeId}`,
        brief: `Build ${nodeId}.`,
        estimate_min: 10,
        tags: [],
        state: "queued",
      },
    },
    idem_key: `add-${nodeId}`,
  });
  store.append(project, {
    actor: `worker:${nodeId}`,
    type: "NODE_STATE_CHANGED",
    payload: { node_id: nodeId, from: "queued", to: "running" },
    idem_key: `running-${nodeId}`,
  });
  store.append(project, {
    actor: `worker:${nodeId}`,
    type: "HANDOFF_FILED",
    payload: { node_id: nodeId, handoff: baseHandoff },
    idem_key: `handoff-${nodeId}`,
  });
  store.append(project, {
    actor: "supervisor",
    type: "APPROVAL_CREATED",
    payload: { approval_id: approvalId, node_id: nodeId, summary: `Review task ${nodeId}.` },
    idem_key: approvalId,
  });
}

function registerBrowserSession(
  store: MissionGraphServer["store"],
  project: string,
  session: string,
  proof: string,
) {
  store.issueBrowserSession({
    id: session,
    token: proof,
    project_id: project,
    created_at: "2026-08-30T10:00:00.000Z",
    expires_at: "2026-09-01T10:00:00.000Z",
  });
}

async function dispatchFleetNode(
  app: MissionGraphServer["app"],
  input: {
    project: string;
    token: string;
    nodeId: string;
    session: string;
    proof: string;
    nonce: string;
  },
) {
  const mutation = {
    type: "DISPATCHED",
    payload: { node_id: input.nodeId, bypass_cap: true },
  };
  const staged = await app.inject({
    method: "POST",
    url: `/api/p/${input.project}/action-drafts`,
    headers: {
      "x-mg-token": input.token,
      "x-mg-session": input.session,
      "x-mg-session-proof": input.proof,
    },
    payload: { mutation, summary: `Dispatch ${input.nodeId} to a real worker.` },
  });
  const draft = staged.json<{ draft_id: string }>();
  const confirmed = await app.inject({
    method: "POST",
    url: `/api/p/${input.project}/action-drafts/${draft.draft_id}/confirm`,
    headers: {
      "x-mg-token": input.token,
      "x-mg-session": input.session,
      "x-mg-session-proof": input.proof,
    },
  });
  const capability = confirmed.json<{ capability_ref: string; capability: string }>();
  const dispatched = await app.inject({
    method: "POST",
    url: `/api/p/${input.project}/mutations`,
    headers: {
      "x-mg-token": input.token,
      "x-mg-session": input.session,
      "x-mg-session-proof": input.proof,
      "x-mg-capability-ref": capability.capability_ref,
      "x-mg-capability": capability.capability,
      "x-mg-nonce": input.nonce,
    },
    payload: { ...mutation, idem_key: `dispatch-${input.project}-${input.nodeId}` },
  });
  return { staged, confirmed, capability, dispatched };
}

async function issuePolicy(
  app: MissionGraphServer["app"],
  input: {
    project: string;
    token: string;
    session: string;
    proof: string;
    text?: string;
    maxUses?: number;
    origin?: string;
  },
) {
  const staged = await app.inject({
    method: "POST",
    url: `/api/p/${input.project}/policy-drafts`,
    headers: {
      "x-mg-token": input.token,
      "x-mg-session": input.session,
      "x-mg-session-proof": input.proof,
    },
    payload: {
      text: input.text ?? "Approve green diffs.",
      ...(input.maxUses === undefined ? {} : { max_uses: input.maxUses }),
    },
  });
  const draft = staged.json<{ draft_id: string }>();
  const confirmed = await app.inject({
    method: "POST",
    url: `/api/p/${input.project}/policy-drafts/${draft.draft_id}/confirm`,
    headers: {
      "x-mg-token": input.token,
      "x-mg-session": input.session,
      "x-mg-session-proof": input.proof,
      ...(input.origin ? { origin: input.origin } : {}),
    },
  });
  return {
    staged,
    confirmed,
    draft,
    grant: confirmed.json<{
      policy_ref: string;
      capability: string;
      allowed_actions: string[];
      max_uses: number;
      expires_at: string;
      confirmed_at: string;
      seq: number;
    }>(),
  };
}

function addFleetNode(
  store: MissionGraphServer["store"],
  project: string,
  nodeId: string,
  title: string,
  brief: string,
  dispatched: boolean,
  briefOverride?: string,
) {
  store.append(project, {
    actor: "human",
    type: "TASK_ADDED",
    payload: {
      node: { id: nodeId, title, brief, estimate_min: 12, tags: ["fleet"], state: "queued" },
    },
    idem_key: `add-${project}-${nodeId}`,
  });
  if (dispatched) {
    store.append(project, {
      actor: "human",
      type: "DISPATCHED",
      payload: {
        node_id: nodeId,
        bypass_cap: true,
        ...(briefOverride === undefined ? {} : { brief_override: briefOverride }),
      },
      idem_key: `dispatch-${project}-${nodeId}`,
    });
  }
}

async function prepareFleet(
  app: MissionGraphServer["app"],
  store: MissionGraphServer["store"],
  candidates: { project: string; token: string; nodeId: string; title: string; brief: string; dispatched?: boolean }[],
) {
  store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
  const templates = new Set<string>();
  for (const candidate of candidates) {
    if (!store.hasProject(candidate.project)) {
      store.createProject(candidate.project, candidate.token, "2026-08-30T09:30:00.000Z", {
        seedProjectId: "seed",
      });
    }
    const templateKey = `${candidate.title}\n${candidate.brief}`;
    if (!templates.has(templateKey)) {
      templates.add(templateKey);
      addFleetNode(store, "seed", `template-${templates.size}`, candidate.title, candidate.brief, false);
    }
    addFleetNode(store, candidate.project, candidate.nodeId, candidate.title, candidate.brief, false);
  }
  for (const project of new Set(candidates.map((candidate) => candidate.project))) {
    store.recordCloneBaseline(project);
    registerBrowserSession(store, project, `fleet-session-${project}`, `fleet-proof-${project}`);
  }
  for (const candidate of candidates) {
    if (candidate.dispatched === false) continue;
    const result = await dispatchFleetNode(app, {
      project: candidate.project,
      token: candidate.token,
      nodeId: candidate.nodeId,
      session: `fleet-session-${candidate.project}`,
      proof: `fleet-proof-${candidate.project}`,
      nonce: `fleet-dispatch-${candidate.project}-${candidate.nodeId}`,
    });
    if (result.dispatched.statusCode !== 200) {
      throw new Error(`failed to dispatch fleet fixture ${candidate.project}/${candidate.nodeId}`);
    }
  }
}

describe("HTTP and streaming contract", () => {
  it("answers CORS preflights only for configured origins", async () => {
    const { app } = server({ allowedOrigins: ["https://missiongraph.vercel.app"] });
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/clone-demo",
      headers: {
        origin: "https://missiongraph.vercel.app",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-mg-token,x-mg-session",
      },
    });
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/api/clone-demo",
      headers: { origin: "https://attacker.example" },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://missiongraph.vercel.app");
    expect(allowed.headers["access-control-allow-headers"]).toContain("x-mg-token");
    expect(allowed.headers["access-control-allow-headers"]).toContain("x-mg-session");
    expect(allowed.headers["access-control-allow-headers"]).toContain("x-mg-session-proof");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("issues project-bound browser sessions without storing their raw proof", async () => {
    const issuedAt = "2026-08-30T10:05:00.000Z";
    const { app, store } = server({ now: () => new Date(issuedAt) });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    const response = await app.inject({
      method: "POST",
      url: "/api/p/project/browser-sessions",
      headers: { "x-mg-token": "visitor-token" },
    });
    const session = response.json<{
      session_id: string;
      session_proof: string;
      expires_at: string;
    }>();
    const stored = store.database
      .prepare("SELECT token_hash, project_id FROM browser_sessions WHERE id = ?")
      .get(session.session_id) as { token_hash: string; project_id: string };

    expect(response.statusCode).toBe(200);
    expect(session.expires_at).toBe("2026-08-30T22:05:00.000Z");
    expect(stored).toMatchObject({ project_id: "project" });
    expect(stored.token_hash).not.toBe(session.session_proof);
    expect(JSON.stringify(stored)).not.toContain(session.session_proof);
    expect(store.browserSessionMatches("project", session.session_id, session.session_proof, issuedAt)).toBe(true);
    expect(store.browserSessionMatches("project", session.session_id, "wrong", issuedAt)).toBe(false);
  });

  it("applies mutation batches atomically with server-assigned ids", async () => {
    const assignedIds = ["node-a", "node-b", "edge-a-b"];
    const { app, store } = server({ id: () => assignedIds.shift() ?? "unexpected-id" });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    const invalid = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: { "x-mg-token": "visitor-token" },
      payload: {
        batch: [
          {
            type: "TASK_ADDED",
            payload: {
              node: { id: "temp-a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
            },
          },
          {
            type: "EDGE_ADDED",
            payload: { edge_id: "temp-edge", upstream: "temp-a", downstream: "missing", kind: "depends" },
          },
        ],
        idem_key: "invalid-plan",
        base_seq: 0,
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(store.listEvents("project")).toEqual([]);

    assignedIds.splice(0, assignedIds.length, "node-a", "node-b", "edge-a-b");
    const validPayload = {
      batch: [
        {
          type: "TASK_ADDED",
          payload: {
            node: { id: "temp-a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
          },
        },
        {
          type: "TASK_ADDED",
          payload: {
            node: { id: "temp-b", title: "Task B", brief: "Build B.", estimate_min: 10, tags: [], state: "queued" },
          },
        },
        {
          type: "EDGE_ADDED",
          payload: { edge_id: "temp-edge", upstream: "temp-a", downstream: "temp-b", kind: "depends" },
        },
      ],
      idem_key: "valid-plan",
      base_seq: 0,
    };
    const valid = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: { "x-mg-token": "visitor-token" },
      payload: validPayload,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: { "x-mg-token": "visitor-token" },
      payload: validPayload,
    });

    expect(valid.json()).toEqual({ seqs: [1, 2, 3] });
    expect(duplicate.json()).toEqual({ seqs: [1, 2, 3] });
    expect(store.listEvents("project")).toMatchObject([
      { actor: "browser_agent", type: "TASK_ADDED", payload: { node: { id: "node-a" } } },
      { actor: "browser_agent", type: "TASK_ADDED", payload: { node: { id: "node-b" } } },
      {
        actor: "browser_agent",
        type: "EDGE_ADDED",
        payload: { edge_id: "edge-a-b", upstream: "node-a", downstream: "node-b" },
      },
    ]);
  });

  it("returns a fresh digest for stale mutations", async () => {
    const { app, store } = server();
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    const first = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: { "x-mg-token": "visitor-token" },
      payload: {
        type: "TASK_ADDED",
        payload: {
          node: { id: "a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
        },
        idem_key: "add-a",
        base_seq: 0,
      },
    });
    const stale = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: { "x-mg-token": "visitor-token" },
      payload: {
        type: "TASK_ADDED",
        payload: {
          node: { id: "b", title: "Task B", brief: "Build B.", estimate_min: 10, tags: [], state: "queued" },
        },
        idem_key: "add-b",
        base_seq: 0,
      },
    });

    expect(first.json()).toEqual({ seq: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ fresh_digest: { cursor: "1", summary: { counts_by_state: { ready: 1 } } } });
    expect(stale.json().fresh_digest.changes_since).toMatchObject([{ seq: 1, actor: "human", type: "TASK_ADDED" }]);
    expect(store.listEvents("project")).toHaveLength(1);
  });

  it("round-trips a reporter-exercised event stream through export and seed import", async () => {
    let currentTime = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({ now: () => currentTime });
    store.createProject("real-project", "visitor-token", currentTime.toISOString());
    store.append(
      "real-project",
      {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: {
            id: "real-node",
            title: "Run a real worker",
            brief: "Capture genuine execution history.",
            estimate_min: 10,
            tags: ["seed"],
            state: "queued",
          },
        },
        idem_key: "real-task",
      },
      { ts: currentTime.toISOString() },
    );
    const report = (type: string, payload: Record<string, unknown>, idemKey: string) =>
      app.inject({
        method: "POST",
        url: "/api/p/real-project/report",
        headers: { authorization: "Bearer reporter-secret" },
        payload: { actor: "supervisor", type, payload, idem_key: idemKey },
      });
    currentTime = new Date("2026-08-30T10:02:30.000Z");
    expect(
      (
        await report(
          "NODE_STATE_CHANGED",
          { node_id: "real-node", from: "queued", to: "running", detail: "Real worker started." },
          "real-running",
        )
      ).statusCode,
    ).toBe(200);
    currentTime = new Date("2026-08-30T10:07:45.000Z");
    expect(
      (
        await report(
          "HANDOFF_FILED",
          {
            node_id: "real-node",
            handoff: { ...baseHandoff, summary: "Distinctive real-run seed handoff." },
          },
          "real-handoff",
        )
      ).statusCode,
    ).toBe(200);

    const unauthorized = await app.inject({ method: "GET", url: "/api/p/real-project/export" });
    const exportedResponse = await app.inject({
      method: "GET",
      url: "/api/p/real-project/export",
      headers: { "x-mg-token": "visitor-token" },
    });
    const exported = exportedResponse.json<{ v: number; events: Record<string, unknown>[] }>();
    const originalEvents = store.listEvents("real-project");
    const fieldNames: string[] = [];
    const collectFieldNames = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collectFieldNames(item);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          fieldNames.push(key);
          collectFieldNames(child);
        }
      }
    };
    collectFieldNames(exported);

    const importedResponse = await app.inject({
      method: "POST",
      url: "/api/import-seed",
      headers: { authorization: "Bearer reporter-secret" },
      payload: exported,
    });
    const imported = importedResponse.json<{ project_id: string; token: string; cursor: string }>();
    const importedEvents = store.listEvents(imported.project_id);
    const relativeTimes = (events: { ts: string }[]) =>
      events.map((event) => Date.parse(event.ts) - Date.parse(events[0]?.ts ?? event.ts));

    expect(unauthorized.statusCode).toBe(401);
    expect(exportedResponse.statusCode).toBe(200);
    expect(exported).toEqual({ v: 1, events: originalEvents });
    expect(fieldNames.filter((key) => /token|credential|authorization|secret/i.test(key))).toEqual([]);
    expect(importedResponse.statusCode).toBe(200);
    expect(imported).toMatchObject({ token: expect.any(String), cursor: String(originalEvents.length) });
    expect(imported.project_id).not.toBe("real-project");
    expect(imported.token).not.toBe("visitor-token");
    expect(importedEvents).toHaveLength(originalEvents.length);
    expect(importedEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(importedEvents.map((event) => event.type)).toEqual(originalEvents.map((event) => event.type));
    expect(importedEvents.map((event) => event.actor)).toEqual(originalEvents.map((event) => event.actor));
    expect(importedEvents.map((event) => event.ts)).toEqual(originalEvents.map((event) => event.ts));
    expect(relativeTimes(importedEvents)).toEqual(relativeTimes(originalEvents));
    expect(store.listEvents("real-project")).toEqual(originalEvents);
    expect(store.tokenMatches(imported.project_id, imported.token)).toBe(true);
  });

  it("requires the supervisor bearer token to import a seed", async () => {
    const { app } = server();
    const withoutBearer = await app.inject({
      method: "POST",
      url: "/api/import-seed",
      payload: { v: 1, events: [] },
    });
    const wrongBearer = await app.inject({
      method: "POST",
      url: "/api/import-seed",
      headers: { authorization: "Bearer wrong" },
      payload: { v: 1, events: [] },
    });

    expect(withoutBearer.statusCode).toBe(401);
    expect(wrongBearer.statusCode).toBe(401);
  });

  it("rejects malformed seed streams without importing a project", async () => {
    const { app, store } = server();
    const validTask = {
      seq: 1,
      project_id: "source",
      ts: "2026-08-30T10:00:00.000Z",
      actor: "human",
      type: "TASK_ADDED",
      payload: {
        node: {
          id: "task-a",
          title: "Task A",
          brief: "Build A.",
          estimate_min: 10,
          tags: [],
          state: "queued",
        },
      },
      idem_key: "task-a",
    };
    const invalidEdge = {
      seq: 2,
      project_id: "source",
      ts: "2026-08-30T10:01:00.000Z",
      actor: "human",
      type: "EDGE_ADDED",
      payload: { edge_id: "edge-a-missing", upstream: "task-a", downstream: "missing", kind: "depends" },
      idem_key: "edge-a-missing",
    };
    const malformed = [
      { v: 2, events: [] },
      { v: 1, events: {} },
      { v: 1, events: [validTask, invalidEdge] },
    ];
    const before = (store.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const responses = [];
    for (const payload of malformed) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/api/import-seed",
          headers: { authorization: "Bearer reporter-secret" },
          payload,
        }),
      );
    }
    const after = (store.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;

    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400]);
    expect(after).toBe(before);
  });

  it("falls back to the built-in fixture seed when no seed project is configured", async () => {
    const { app, store } = server();
    store.createProject("demo-seed", "seed-token", "2026-08-30T10:00:00.000Z");
    store.append("demo-seed", {
      actor: "human",
      type: "TASK_ADDED",
      payload: {
        node: { id: "seed-node", title: "Seed task", brief: "A real seed task.", estimate_min: 5, tags: [], state: "queued" },
      },
      idem_key: "seed-add",
    });
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string; cursor: string }>();
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/p/${body.project}/snapshot`,
      headers: { "x-mg-token": body.token },
    });
    const nodeIds = Object.keys(snapshot.json<{ state: { nodes: Record<string, unknown> } }>().state.nodes);

    expect(clone.statusCode).toBe(200);
    expect(body.project).not.toBe("demo-seed");
    expect(body.cursor).toBe("1");
    expect(nodeIds).toHaveLength(1);
    expect(nodeIds).not.toContain("seed-node");
  });

  it("clones a configured real-run seed without changing the source project", async () => {
    const { app, store } = server({
      seedProjectId: "real-seed",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    store.createProject("demo-seed", "fixture-token", "2026-08-30T09:00:00.000Z");
    store.append("demo-seed", {
      actor: "human",
      type: "JOURNAL_NOTE",
      payload: { text: "Fixture-only marker." },
      idem_key: "fixture-marker",
    });
    store.createProject("real-seed", "real-token", "2026-08-30T10:00:00.000Z");
    store.append(
      "real-seed",
      {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: {
            id: "real-node",
            title: "Real worker task",
            brief: "This task was completed by a real worker.",
            estimate_min: 10,
            tags: ["real-run"],
            state: "running",
          },
        },
        idem_key: "real-task",
      },
      { ts: "2026-08-30T10:00:00.000Z" },
    );
    store.append(
      "real-seed",
      {
        actor: "worker:real-node",
        type: "HANDOFF_FILED",
        payload: {
          node_id: "real-node",
          handoff: { ...baseHandoff, summary: "Distinctive HANDOFF_FILED summary from a real run." },
        },
        idem_key: "real-handoff",
      },
      { ts: "2026-08-30T10:05:00.000Z" },
    );
    const sourceBefore = structuredClone(store.listEvents("real-seed"));

    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string }>();
    const clonedEvents = store.listEvents(body.project);
    const handoff = clonedEvents.find((event) => event.type === "HANDOFF_FILED");

    expect(clone.statusCode).toBe(200);
    expect(clonedEvents.map((event) => event.type)).toEqual(["TASK_ADDED", "HANDOFF_FILED"]);
    expect(handoff).toMatchObject({
      payload: { handoff: { summary: "Distinctive HANDOFF_FILED summary from a real run." } },
    });
    expect(store.getProject(body.project)?.seed_project_id).toBe("real-seed");
    expect(store.listEvents("real-seed")).toEqual(sourceBefore);
  });

  it("warns and falls back to the fixture when the configured seed is missing", async () => {
    const { app, store } = server({ seedProjectId: "missing-real-seed" });
    const warning = vi.spyOn(app.log, "warn");
    store.createProject("demo-seed", "fixture-token", "2026-08-30T10:00:00.000Z");
    store.append("demo-seed", {
      actor: "human",
      type: "JOURNAL_NOTE",
      payload: { text: "Fixture fallback marker." },
      idem_key: "fixture-marker",
    });

    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string }>();

    expect(clone.statusCode).toBe(200);
    expect(store.listEvents(body.project)).toMatchObject([
      { type: "JOURNAL_NOTE", payload: { text: "Fixture fallback marker." } },
    ]);
    expect(store.getProject(body.project)?.seed_project_id).toBe("demo-seed");
    expect(warning).toHaveBeenCalledWith(
      { seedProjectId: "missing-real-seed" },
      "Configured seed project is missing; falling back to the built-in fixture seed",
    );
  });

  it("anchors the latest cloned seed event at clone time", async () => {
    const cloneTime = new Date("2026-08-30T12:00:00.000Z");
    const { app, store } = server({ now: () => cloneTime });
    store.createProject("demo-seed", "seed-token", "2026-08-30T10:00:00.000Z");
    store.append(
      "demo-seed",
      {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: {
            id: "running-seed-node",
            title: "Running seed task",
            brief: "A real running seed task.",
            estimate_min: 5,
            tags: [],
            state: "running",
          },
        },
        idem_key: "seed-add",
      },
      { ts: "2026-08-30T10:00:00.000Z" },
    );
    store.append(
      "demo-seed",
      {
        actor: "human",
        type: "JOURNAL_NOTE",
        payload: { text: "Seed history is still real." },
        idem_key: "seed-note",
      },
      { ts: "2026-08-30T10:05:00.000Z" },
    );

    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string }>();
    const clonedEvents = store.listEvents(body.project);

    expect(clonedEvents.map((event) => event.ts)).toEqual([
      "2026-08-30T11:55:00.000Z",
      "2026-08-30T12:00:00.000Z",
      "2026-08-30T12:00:00.000Z",
    ]);
    expect(clonedEvents.at(-1)).toMatchObject({
      type: "NODE_STATE_CHANGED",
      payload: { from: "running", to: "paused", detail: "worker detached during visitor clone" },
    });
    expect(clonedEvents.every((event) => Date.parse(event.ts) <= cloneTime.getTime())).toBe(true);
  });

  it("stages policies without minting grants and derives accepted approval actors", async () => {
    const confirmedAt = "2026-08-30T10:05:00.000Z";
    const { app, store } = server({ now: () => new Date(confirmedAt) });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    seedPendingApproval(store, "project", "a");

    const selfMint = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-actor": "human",
      },
      payload: {
        type: "POLICY_STATED",
        payload: {
          policy_ref: "self-minted",
          text: "Approve everything.",
          scope: "session",
          session_id: "session-a",
        },
        idem_key: "self-minted",
      },
    });
    const staged = await app.inject({
      method: "POST",
      url: "/api/p/project/policy-drafts",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
      payload: { text: "Approve green diffs.", max_uses: 4 },
    });
    const stagedBody = staged.json<{
      draft_id: string;
      allowed_actions: string[];
      max_uses: number;
      expires_at: string;
    }>();
    const spoofedHuman = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-actor": "human",
      },
      payload: {
        type: "APPROVED",
        payload: { approval_id: "approval-a", node_id: "a" },
        idem_key: "spoofed-human",
      },
    });

    expect(selfMint.statusCode).toBe(403);
    expect(staged.statusCode).toBe(200);
    expect(stagedBody).toMatchObject({
      allowed_actions: ["approve", "reject"],
      max_uses: 4,
    });
    expect(stagedBody).not.toHaveProperty("policy_ref");
    expect(stagedBody).not.toHaveProperty("capability");
    expect(spoofedHuman).toMatchObject({ statusCode: 403 });
    expect(spoofedHuman.json()).toMatchObject({ error: { code: "capability_required" } });
    expect(store.listEvents("project")).toHaveLength(4);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/p/project/policy-drafts/${stagedBody.draft_id}/confirm`,
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        origin: "https://missiongraph.vercel.app",
      },
    });
    const grant = confirmed.json<{ policy_ref: string; capability: string; seq: number }>();
    const storedGrant = store.database
      .prepare("SELECT token_hash FROM human_capabilities WHERE ref = ?")
      .get(grant.policy_ref) as { token_hash: string };
    const approved = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-actor": "human",
        "x-mg-capability-ref": grant.policy_ref,
        "x-mg-capability": grant.capability,
        "x-mg-nonce": "approval-use-a",
      },
      payload: {
        type: "APPROVED",
        payload: { approval_id: "approval-a", node_id: "a", policy_ref: grant.policy_ref },
        idem_key: "approved-a",
      },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(grant.seq).toBe(5);
    expect(storedGrant.token_hash).not.toBe(grant.capability);
    expect(JSON.stringify(storedGrant)).not.toContain(grant.capability);
    expect(approved.json()).toEqual({ seq: 6 });
    expect(store.listEvents("project").slice(-2)).toMatchObject([
      {
        actor: "human",
        type: "POLICY_STATED",
        payload: {
          policy_ref: grant.policy_ref,
          text: "Approve green diffs.",
          confirmed_at: confirmedAt,
          request_origin: "https://missiongraph.vercel.app",
        },
      },
      {
        actor: "browser_agent",
        type: "APPROVED",
        payload: {
          policy_ref: grant.policy_ref,
          authorization: {
            policy_text: "Approve green diffs.",
            confirmed_at: confirmedAt,
            request_origin: "https://missiongraph.vercel.app",
            use_nonce: "approval-use-a",
          },
        },
      },
    ]);
  });

  it("rejects foreign-session and foreign-project human capabilities without writes", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    for (const { project, token } of [
      { project: "project-a", token: "visitor-a" },
      { project: "project-b", token: "visitor-b" },
    ]) {
      store.createProject(project, token, "2026-08-30T10:00:00.000Z");
      seedPendingApproval(store, project, "task");
    }
    registerBrowserSession(store, "project-a", "session-a", "proof-a");
    registerBrowserSession(store, "project-a", "session-b", "proof-b");
    registerBrowserSession(store, "project-b", "session-project-b", "proof-project-b");
    const { grant } = await issuePolicy(app, {
      project: "project-a",
      token: "visitor-a",
      session: "session-a",
      proof: "proof-a",
    });
    const request = (project: string, session: string, proof: string, idemKey: string) =>
      app.inject({
        method: "POST",
        url: `/api/p/${project}/agent-mutations`,
        headers: {
          "x-mg-token": project === "project-a" ? "visitor-a" : "visitor-b",
          "x-mg-session": session,
          "x-mg-session-proof": proof,
          "x-mg-capability-ref": grant.policy_ref,
          "x-mg-capability": grant.capability,
          "x-mg-nonce": idemKey,
        },
        payload: {
          type: "APPROVED",
          payload: { approval_id: "approval-task", node_id: "task", policy_ref: grant.policy_ref },
          idem_key: idemKey,
        },
      });
    const projectACount = store.listEvents("project-a").length;
    const projectBCount = store.listEvents("project-b").length;
    const foreignSession = await request("project-a", "session-b", "proof-b", "foreign-session");
    const foreignProject = await request(
      "project-b",
      "session-project-b",
      "proof-project-b",
      "foreign-project",
    );

    expect(foreignSession.json()).toMatchObject({ error: { code: "capability_invalid" } });
    expect(foreignProject.json()).toMatchObject({ error: { code: "capability_invalid" } });
    expect(store.listEvents("project-a")).toHaveLength(projectACount);
    expect(store.listEvents("project-b")).toHaveLength(projectBCount);
  });

  it("binds an approval policy_ref to the exact consumed capability", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    seedPendingApproval(store, "project", "a");
    const { grant: first } = await issuePolicy(app, {
      project: "project",
      token: "visitor-token",
      session: "session-a",
      proof: "proof-a",
      text: "Approve green diffs.",
    });
    const { grant: second } = await issuePolicy(app, {
      project: "project",
      token: "visitor-token",
      session: "session-a",
      proof: "proof-a",
      text: "Approve green diffs.",
    });
    const before = store.listEvents("project").length;
    const mismatched = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-capability-ref": first.policy_ref,
        "x-mg-capability": first.capability,
        "x-mg-nonce": "same-text-use",
      },
      payload: {
        type: "APPROVED",
        payload: {
          approval_id: "approval-a",
          node_id: "a",
          policy_ref: second.policy_ref,
        },
        idem_key: "mismatched-policy-ref",
      },
    });

    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: "invalid_event" } });
    expect(store.listEvents("project")).toHaveLength(before);
    expect(
      store.database
        .prepare("SELECT 1 AS found FROM human_capability_uses WHERE nonce = ?")
        .get("same-text-use"),
    ).toBeUndefined();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-capability-ref": first.policy_ref,
        "x-mg-capability": first.capability,
        "x-mg-nonce": "same-text-use",
      },
      payload: {
        type: "APPROVED",
        payload: {
          approval_id: "approval-a",
          node_id: "a",
          policy_ref: first.policy_ref,
        },
        idem_key: "matched-policy-ref",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(store.listEvents("project").at(-1)?.payload).toMatchObject({
      policy_ref: first.policy_ref,
      authorization: { capability_ref: first.policy_ref, use_nonce: "same-text-use" },
    });
  });

  it("atomically confirms policy drafts and safely rotates material on retry", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    const staged = await app.inject({
      method: "POST",
      url: "/api/p/project/policy-drafts",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
      payload: { text: "Approve green diffs." },
    });
    const { draft_id: draftId } = staged.json<{ draft_id: string }>();
    const confirm = () =>
      app.inject({
        method: "POST",
        url: `/api/p/project/policy-drafts/${draftId}/confirm`,
        headers: {
          "x-mg-token": "visitor-token",
          "x-mg-session": "session-a",
          "x-mg-session-proof": "proof-a",
        },
      });

    store.database.exec(`
      CREATE TRIGGER fail_policy_append
      BEFORE INSERT ON events
      WHEN NEW.type = 'POLICY_STATED'
      BEGIN
        SELECT RAISE(ABORT, 'injected append failure');
      END
    `);
    const failed = await confirm();
    expect(failed.statusCode).toBe(500);
    expect(
      store.database
        .prepare("SELECT confirmed_at FROM human_drafts WHERE id = ?")
        .get(draftId),
    ).toEqual({ confirmed_at: null });
    expect(
      store.database
        .prepare("SELECT 1 AS found FROM human_capabilities WHERE ref = ?")
        .get(draftId),
    ).toBeUndefined();
    expect(store.listEvents("project")).toEqual([]);

    store.database.exec("DROP TRIGGER fail_policy_append");
    const first = await confirm();
    const second = await confirm();
    const firstGrant = first.json<{ policy_ref: string; capability: string; seq: number }>();
    const secondGrant = second.json<{ policy_ref: string; capability: string; seq: number }>();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(secondGrant.policy_ref).toBe(firstGrant.policy_ref);
    expect(secondGrant.seq).toBe(firstGrant.seq);
    expect(secondGrant.capability).not.toBe(firstGrant.capability);
    expect(store.listEvents("project").filter((event) => event.type === "POLICY_STATED")).toHaveLength(1);
  });

  it("rejects modified, replayed, and exhausted policy grants without writes", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    for (const nodeId of ["a", "b", "c"]) seedPendingApproval(store, "project", nodeId);
    const { grant } = await issuePolicy(app, {
      project: "project",
      token: "visitor-token",
      session: "session-a",
      proof: "proof-a",
      maxUses: 2,
    });
    const approve = (nodeId: string, nonce: string) =>
      app.inject({
        method: "POST",
        url: "/api/p/project/agent-mutations",
        headers: {
          "x-mg-token": "visitor-token",
          "x-mg-session": "session-a",
          "x-mg-session-proof": "proof-a",
          "x-mg-capability-ref": grant.policy_ref,
          "x-mg-capability": grant.capability,
          "x-mg-nonce": nonce,
        },
        payload: {
          type: "APPROVED",
          payload: {
            approval_id: `approval-${nodeId}`,
            node_id: nodeId,
            policy_ref: grant.policy_ref,
          },
          idem_key: `approve-${nodeId}-${nonce}`,
        },
      });

    const multiApproval = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-capability-ref": grant.policy_ref,
        "x-mg-capability": grant.capability,
        "x-mg-nonce": "batch-nonce",
      },
      payload: {
        batch: ["a", "b"].map((nodeId) => ({
          type: "APPROVED",
          payload: {
            approval_id: `approval-${nodeId}`,
            node_id: nodeId,
            policy_ref: grant.policy_ref,
          },
        })),
        idem_key: "multi-approval",
      },
    });
    expect(multiApproval.json()).toMatchObject({ error: { code: "invalid_event" } });
    expect((await approve("a", "batch-nonce")).statusCode).toBe(200);
    const afterFirst = store.listEvents("project").length;
    const replayed = await approve("b", "batch-nonce");
    expect(replayed.json()).toMatchObject({ error: { code: "capability_replayed" } });
    expect(store.listEvents("project")).toHaveLength(afterFirst);
    expect((await approve("b", "nonce-b")).statusCode).toBe(200);
    const afterSecond = store.listEvents("project").length;
    const exhausted = await approve("c", "nonce-c");
    expect(exhausted.json()).toMatchObject({ error: { code: "capability_exhausted" } });
    expect(store.listEvents("project")).toHaveLength(afterSecond);

    store.createProject("modified", "modified-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "modified", "session-m", "proof-m");
    seedPendingApproval(store, "modified", "d");
    const { grant: modifiedGrant } = await issuePolicy(app, {
      project: "modified",
      token: "modified-token",
      session: "session-m",
      proof: "proof-m",
      maxUses: 1,
    });
    const policyRow = store.database
      .prepare("SELECT seq, payload_json FROM events WHERE project_id = ? AND type = 'POLICY_STATED'")
      .get("modified") as { seq: number; payload_json: string };
    const storedPayload = JSON.parse(policyRow.payload_json) as { v: number; data: { text: string } };
    storedPayload.data.text = "Modified after confirmation.";
    store.database
      .prepare("UPDATE events SET payload_json = ? WHERE seq = ?")
      .run(JSON.stringify(storedPayload), policyRow.seq);
    const beforeModified = store.listEvents("modified").length;
    const modified = await app.inject({
      method: "POST",
      url: "/api/p/modified/agent-mutations",
      headers: {
        "x-mg-token": "modified-token",
        "x-mg-session": "session-m",
        "x-mg-session-proof": "proof-m",
        "x-mg-capability-ref": modifiedGrant.policy_ref,
        "x-mg-capability": modifiedGrant.capability,
        "x-mg-nonce": "modified-use",
      },
      payload: {
        type: "APPROVED",
        payload: {
          approval_id: "approval-d",
          node_id: "d",
          policy_ref: modifiedGrant.policy_ref,
        },
        idem_key: "modified-approval",
      },
    });
    expect(modified.json()).toMatchObject({ error: { code: "capability_invalid" } });
    expect(store.listEvents("modified")).toHaveLength(beforeModified);
  });

  it("rejects an expired policy grant without appending an event", async () => {
    let clock = new Date("2026-08-30T10:05:00.000Z");
    const { app, store } = server({ now: () => clock });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    seedPendingApproval(store, "project", "a");
    const { grant } = await issuePolicy(app, {
      project: "project",
      token: "visitor-token",
      session: "session-a",
      proof: "proof-a",
    });
    const before = store.listEvents("project").length;
    clock = new Date("2026-08-30T10:21:00.000Z");
    const expired = await app.inject({
      method: "POST",
      url: "/api/p/project/agent-mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-capability-ref": grant.policy_ref,
        "x-mg-capability": grant.capability,
        "x-mg-nonce": "expired-use",
      },
      payload: {
        type: "APPROVED",
        payload: { approval_id: "approval-a", node_id: "a", policy_ref: grant.policy_ref },
        idem_key: "expired-approval",
      },
    });

    expect(expired.json()).toMatchObject({ error: { code: "capability_expired" } });
    expect(store.listEvents("project")).toHaveLength(before);
  });

  it("binds dispatch confirmation to one exact action and records its audit", async () => {
    const confirmedAt = "2026-08-30T10:05:00.000Z";
    const { app, store } = server({ now: () => new Date(confirmedAt) });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    for (const nodeId of ["a", "b"]) {
      store.append("project", {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: {
            id: nodeId,
            title: `Task ${nodeId}`,
            brief: `Build ${nodeId}.`,
            estimate_min: 10,
            tags: [],
            state: "queued",
          },
        },
        idem_key: `add-${nodeId}`,
      });
    }
    const mutation = {
      type: "DISPATCHED",
      payload: { node_id: "a", bypass_cap: true },
    };
    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-actor": "human",
      },
      payload: { ...mutation, idem_key: "unconfirmed-dispatch" },
    });
    const staged = await app.inject({
      method: "POST",
      url: "/api/p/project/action-drafts",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
      payload: { mutation, summary: "Dispatch Task a to a real worker." },
    });
    const draft = staged.json<{
      draft_id: string;
      action: string;
      subject_hash: string;
      max_uses: number;
    }>();
    const beforeConfirm = store.listEvents("project").length;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/p/project/action-drafts/${draft.draft_id}/confirm`,
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        origin: "https://missiongraph.vercel.app",
      },
    });
    const capability = confirmed.json<{ capability_ref: string; capability: string }>();
    const modified = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-capability-ref": capability.capability_ref,
        "x-mg-capability": capability.capability,
        "x-mg-nonce": "modified-dispatch",
      },
      payload: {
        type: "DISPATCHED",
        payload: { node_id: "b", bypass_cap: true },
        idem_key: "modified-dispatch",
      },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
        "x-mg-actor": "browser_agent",
        "x-mg-capability-ref": capability.capability_ref,
        "x-mg-capability": capability.capability,
        "x-mg-nonce": "accepted-dispatch",
      },
      payload: { ...mutation, idem_key: "accepted-dispatch" },
    });

    expect(unconfirmed.json()).toMatchObject({ error: { code: "capability_required" } });
    expect(staged.statusCode).toBe(200);
    expect(draft).toMatchObject({ action: "dispatch", max_uses: 1 });
    expect(store.listEvents("project").length).toBe(beforeConfirm + 1);
    expect(modified.json()).toMatchObject({ error: { code: "capability_invalid" } });
    expect(accepted.json()).toEqual({ seq: beforeConfirm + 1 });
    expect(store.listEvents("project").at(-1)).toMatchObject({
      actor: "human",
      type: "DISPATCHED",
      payload: {
        node_id: "a",
        authorization: {
          capability_ref: capability.capability_ref,
          confirmed_at: confirmedAt,
          request_origin: "https://missiongraph.vercel.app",
          use_nonce: "accepted-dispatch",
        },
      },
    });
  });

  it("persists denial so a rejected draft cannot mint a capability", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    registerBrowserSession(store, "project", "session-a", "proof-a");
    const staged = await app.inject({
      method: "POST",
      url: "/api/p/project/policy-drafts",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
      payload: { text: "Approve green diffs." },
    });
    const { draft_id: draftId } = staged.json<{ draft_id: string }>();
    const wrongKind = await app.inject({
      method: "POST",
      url: `/api/p/project/action-drafts/${draftId}/confirm`,
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/p/project/human-drafts/${draftId}/deny`,
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/p/project/policy-drafts/${draftId}/confirm`,
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-session": "session-a",
        "x-mg-session-proof": "proof-a",
      },
    });

    expect(wrongKind.json()).toMatchObject({ error: { code: "capability_invalid" } });
    expect(denied.statusCode).toBe(204);
    expect(confirmed.json()).toMatchObject({ error: { code: "capability_denied" } });
    expect(store.listEvents("project")).toEqual([]);
  });

  it("excludes session policies from visitor clone imports", async () => {
    const { app, store } = server();
    store.createProject("demo-seed", "seed-token", "2026-08-30T10:00:00.000Z");
    store.append(
      "demo-seed",
      {
        actor: "human",
        type: "POLICY_STATED",
        payload: {
          policy_ref: "seed-policy",
          text: "Approve green diffs.",
          scope: "session",
          session_id: "seed-session",
        },
        idem_key: "seed-policy",
      },
      { sessionId: "seed-session" },
    );
    store.append("demo-seed", {
      actor: "human",
      type: "JOURNAL_NOTE",
      payload: { text: "Keep this real seed decision." },
      idem_key: "seed-note",
    });

    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/p/${body.project}/snapshot`,
      headers: { "x-mg-token": body.token },
    });

    expect(store.listEvents(body.project).map((event) => event.type)).toEqual(["JOURNAL_NOTE"]);
    expect(snapshot.json<{ state: { policies: Record<string, unknown> } }>().state.policies).toEqual({});
  });

  it("authenticates fleet reports separately from visitor mutations", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    store.issueReporterCredential("project", "worker:a", "2026-08-30T10:00:00.000Z", "worker-a-token");
    store.append("project", {
      actor: "human",
      type: "TASK_ADDED",
      payload: {
        node: { id: "a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
      },
      idem_key: "add-a",
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/p/project/report",
      headers: { authorization: "Bearer wrong" },
      payload: {
        actor: "worker:a",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "a", from: "queued", to: "running" },
        idem_key: "running-a",
      },
    });
    const supervisorTokenAsWorker = await app.inject({
      method: "POST",
      url: "/api/p/project/report",
      headers: { authorization: "Bearer reporter-secret" },
      payload: {
        actor: "worker:a",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "a", from: "queued", to: "running" },
        idem_key: "running-a",
      },
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/api/p/project/report",
      headers: { authorization: "Bearer worker-a-token" },
      payload: {
        actor: "worker:a",
        type: "NODE_STATE_CHANGED",
        payload: { node_id: "a", from: "queued", to: "running" },
        idem_key: "running-a",
      },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(supervisorTokenAsWorker.statusCode).toBe(401);
    expect(authorized.json()).toEqual({ seq: 2 });
  });

  it("binds worker reporter events to the credential node", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    store.issueReporterCredential("project", "worker:a", "2026-08-30T10:00:00.000Z", "worker-a-token");
    for (const nodeId of ["a", "b"]) {
      store.append("project", {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: { id: nodeId, title: `Task ${nodeId}`, brief: `Build ${nodeId}.`, estimate_min: 10, tags: [], state: "queued" },
        },
        idem_key: `add-${nodeId}`,
      });
    }
    const report = (type: string, payload: Record<string, unknown>, idemKey: string) =>
      app.inject({
        method: "POST",
        url: "/api/p/project/report",
        headers: { authorization: "Bearer worker-a-token" },
        payload: { actor: "worker:a", type, payload, idem_key: idemKey },
      });

    const crossState = await report(
      "NODE_STATE_CHANGED",
      { node_id: "b", from: "queued", to: "running" },
      "cross-state",
    );
    const crossHandoff = await report(
      "HANDOFF_FILED",
      { node_id: "b", handoff: baseHandoff },
      "cross-handoff",
    );
    const crossApproval = await report(
      "APPROVAL_CREATED",
      { approval_id: "approval-b", node_id: "b", summary: "Review task B." },
      "cross-approval",
    );
    const ownState = await report(
      "NODE_STATE_CHANGED",
      { node_id: "a", from: "queued", to: "running" },
      "own-state",
    );
    const ownHandoff = await report(
      "HANDOFF_FILED",
      { node_id: "a", handoff: baseHandoff },
      "own-handoff",
    );
    const ownApproval = await report(
      "APPROVAL_CREATED",
      { approval_id: "approval-a", node_id: "a", summary: "Review task A." },
      "own-approval",
    );

    expect([crossState.statusCode, crossHandoff.statusCode, crossApproval.statusCode]).toEqual([403, 403, 403]);
    expect([ownState.statusCode, ownHandoff.statusCode, ownApproval.statusCode]).toEqual([200, 200, 200]);
  });

  it("issues renewable reporter credentials only to the supervisor scope", async () => {
    let reportTime = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({ now: () => reportTime });
    for (const [project, visitor] of [["project-a", "visitor-a"], ["project-b", "visitor-b"]] as const) {
      store.createProject(project, visitor, "2026-08-30T10:00:00.000Z");
      store.append(project, {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: { id: "a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
        },
        idem_key: "add-a",
      });
    }
    const issue = (authorization?: string) =>
      app.inject({
        method: "POST",
        url: "/api/p/project-a/reporter-credentials",
        headers: authorization ? { authorization } : {},
        payload: { actor: "worker:a" },
      });

    const missingAuth = await issue();
    const wrongAuth = await issue("Bearer wrong");
    const unknownWorker = await app.inject({
      method: "POST",
      url: "/api/p/project-a/reporter-credentials",
      headers: { authorization: "Bearer reporter-secret" },
      payload: { actor: "worker:ghost" },
    });
    const first = await issue("Bearer reporter-secret");
    const firstCredential = first.json<{ token: string; actor: string; expires: string }>();
    const report = (project: string, token: string, actor: string, idemKey: string) =>
      app.inject({
        method: "POST",
        url: `/api/p/${project}/report`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          actor,
          type: "WORKER_LOG",
          payload: { node_id: "a", lines: ["Worker is active."] },
          idem_key: idemKey,
        },
      });

    const crossProject = await report("project-b", firstCredential.token, "worker:a", "cross-project");
    const wrongActor = await report("project-a", firstCredential.token, "worker:b", "wrong-actor");
    const firstWorking = await report("project-a", firstCredential.token, "worker:a", "first-working");
    reportTime = new Date("2026-08-30T10:14:00.000Z");
    const renewal = await issue("Bearer reporter-secret");
    const replacement = renewal.json<{ token: string; actor: string; expires: string }>();
    reportTime = new Date("2026-08-30T10:15:00.000Z");
    const expired = await report("project-a", firstCredential.token, "worker:a", "expired");
    const replacementWorking = await report("project-a", replacement.token, "worker:a", "replacement-working");

    expect(missingAuth.statusCode).toBe(401);
    expect(wrongAuth.statusCode).toBe(401);
    expect(unknownWorker.statusCode).toBe(404);
    expect(first.statusCode).toBe(200);
    expect(firstCredential).toMatchObject({ actor: "worker:a", expires: "2026-08-30T10:15:00.000Z" });
    expect(firstCredential.token).toEqual(expect.any(String));
    expect(crossProject.statusCode).toBe(401);
    expect(wrongActor.statusCode).toBe(401);
    expect(firstWorking.statusCode).toBe(200);
    expect(replacement).toMatchObject({ actor: "worker:a", expires: "2026-08-30T10:29:00.000Z" });
    expect(replacement.token).not.toBe(firstCredential.token);
    expect(expired.statusCode).toBe(401);
    expect(replacementWorking.statusCode).toBe(200);
  });

  it("accepts supervisor journal reports and rejects worker journal reports", async () => {
    const { app, store } = server({ now: () => new Date("2026-08-30T10:05:00.000Z") });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    store.issueReporterCredential("project", "worker:a", "2026-08-30T10:00:00.000Z", "worker-a-token");
    const journal = (token: string, actor: "supervisor" | "worker:a", idemKey: string) =>
      app.inject({
        method: "POST",
        url: "/api/p/project/report",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          actor,
          type: "JOURNAL_NOTE",
          payload: { text: "Supervisor recorded a project decision." },
          idem_key: idemKey,
        },
      });

    const supervisor = await journal("reporter-secret", "supervisor", "supervisor-note");
    const worker = await journal("worker-a-token", "worker:a", "worker-note");

    expect(supervisor.json()).toEqual({ seq: 1 });
    expect(worker.statusCode).toBe(400);
    expect(store.listEvents("project")).toMatchObject([
      { actor: "supervisor", type: "JOURNAL_NOTE", payload: { text: "Supervisor recorded a project decision." } },
    ]);
  });

  it("binds short-lived reporter credentials to one project and actor", async () => {
    let reportTime = new Date("2026-08-30T10:05:00.000Z");
    const { app, store } = server({ now: () => reportTime });
    const created = store.createProject("project-a", "visitor-a", "2026-08-30T10:00:00.000Z", {
      reporterToken: "project-a-supervisor",
    });
    store.createProject("project-b", "visitor-b", "2026-08-30T10:00:00.000Z");
    const worker = store.issueReporterCredential(
      "project-a",
      "worker:a",
      "2026-08-30T10:00:00.000Z",
      "project-a-worker",
    );
    for (const project of ["project-a", "project-b"]) {
      store.append(project, {
        actor: "human",
        type: "TASK_ADDED",
        payload: {
          node: { id: "a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
        },
        idem_key: "add-a",
      });
    }
    const report = (project: string, token: string, actor: string, idemKey: string) =>
      app.inject({
        method: "POST",
        url: `/api/p/${project}/report`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          actor,
          type: "WORKER_LOG",
          payload: { node_id: "a", lines: ["Worker is active."] },
          idem_key: idemKey,
        },
      });

    const crossProject = await report("project-b", worker.token, "worker:a", "cross-project");
    const wrongActor = await report("project-a", worker.token, "worker:b", "wrong-actor");
    const authorized = await report("project-a", worker.token, "worker:a", "authorized");
    const projectSupervisor = await report(
      "project-a",
      created.reporter_credential.token,
      "supervisor",
      "project-supervisor",
    );
    reportTime = new Date("2026-08-30T10:15:00.001Z");
    const expired = await report("project-a", worker.token, "worker:a", "expired");

    expect(crossProject.statusCode).toBe(401);
    expect(wrongActor.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(projectSupervisor.statusCode).toBe(200);
    expect(expired.statusCode).toBe(401);
    expect(store.listEvents("project-a").map((event) => event.idem_key)).toEqual([
      "add-a",
      "authorized",
      "project-supervisor",
    ]);
  });

  it("replays from a websocket cursor and then streams live events", async () => {
    const { app, store } = server();
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    store.append("project", {
      actor: "human",
      type: "TASK_ADDED",
      payload: {
        node: { id: "a", title: "Task A", brief: "Build A.", estimate_min: 10, tags: [], state: "queued" },
      },
      idem_key: "add-a",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}/ws?project=project&from_seq=0&token=visitor-token`);
    const messagePromise = once(socket, "message");
    await once(socket, "open");
    const [data] = (await messagePromise) as [Buffer];
    const message = JSON.parse(data.toString()) as { kind: string; event: { seq: number } };
    const livePromise = once(socket, "message");
    store.append("project", {
      actor: "human",
      type: "JOURNAL_NOTE",
      payload: { text: "A live decision." },
      idem_key: "live-journal",
    });
    const [liveData] = (await livePromise) as [Buffer];
    const liveMessage = JSON.parse(liveData.toString()) as { kind: string; event: { seq: number } };
    const closePromise = once(socket, "close");
    socket.close();
    await closePromise;

    expect(message).toMatchObject({ kind: "event", event: { seq: 1 } });
    expect(liveMessage).toMatchObject({ kind: "event", event: { seq: 2 } });
  });

  it("provides SSE replay with the websocket message shape", async () => {
    const { app, store } = server();
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    store.append("project", {
      actor: "human",
      type: "JOURNAL_NOTE",
      payload: { text: "Replay this decision." },
      idem_key: "journal",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/sse?project=project&from_seq=0&token=visitor-token`, {
      signal: controller.signal,
    });
    const chunk = await response.body?.getReader().read();
    controller.abort();
    const text = new TextDecoder().decode(chunk?.value);

    expect(response.status).toBe(200);
    expect(text).toContain('data: {"kind":"event","event":{"seq":1');
  });

  it("runs a fleet request through enqueue, claim, heartbeat, and completion", async () => {
    let clock = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed", now: () => clock });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "task", title: "Build API", brief: "Implement it." },
    ]);

    const enqueued = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });
    const request = enqueued.json<{ id: string; status: string; position: number }>();
    clock = new Date("2026-08-30T10:00:10.000Z");
    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:00:20.000Z");
    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/fleet/${request.id}/heartbeat`,
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:00:30.000Z");
    const completed = await app.inject({
      method: "POST",
      url: `/api/fleet/${request.id}/complete`,
      headers: { "x-mg-reporter": "reporter-secret" },
      payload: { outcome: "done", note: "Worker finished cleanly." },
    });
    const status = await app.inject({
      method: "GET",
      url: `/api/p/project/fleet-requests/${request.id}`,
      headers: { "x-mg-token": "visitor-token" },
    });

    expect(enqueued.statusCode).toBe(200);
    expect(request).toMatchObject({ status: "queued", position: 1 });
    expect(claimed.json()).toMatchObject({
      request_id: request.id,
      project_id: "project",
      node_id: "task",
      node: { title: "Build API", brief: "Implement it.", estimate: 12 },
      visitor_token: "visitor-token",
    });
    expect(heartbeat.json()).toEqual({ id: request.id, status: "running" });
    expect(completed.json()).toEqual({ id: request.id, status: "done" });
    expect(status.json()).toEqual({
      id: request.id,
      status: "done",
      adopted_at: "2026-08-30T10:00:20.000Z",
      finished_at: "2026-08-30T10:00:30.000Z",
      outcome: "done",
    });
    expect(
      store.database.prepare("SELECT note FROM fleet_requests WHERE id = ?").get(request.id),
    ).toEqual({ note: "Worker finished cleanly." });
  });

  it("rejects a fleet dispatch inherited from the seed before the clone baseline", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", true);
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    const clonedNode = store.listEvents(body.project).find((event) => event.type === "TASK_ADDED");
    if (!clonedNode || clonedNode.type !== "TASK_ADDED") throw new Error("cloned task missing");

    const enqueued = await app.inject({
      method: "POST",
      url: `/api/p/${body.project}/fleet-requests`,
      headers: { "x-mg-token": body.token },
      payload: { node_id: clonedNode.payload.node.id },
    });

    expect(enqueued.statusCode).toBe(400);
    expect(enqueued.json()).toMatchObject({ error: { code: "node_not_dispatched" } });
  });

  it("rejects an exact-copy task authored after the clone baseline at enqueue", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", false);
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    addFleetNode(store, body.project, "authored-copy", "Build API", "Implement it.", false);
    registerBrowserSession(store, body.project, "clone-session", "clone-proof");
    const dispatch = await dispatchFleetNode(app, {
      project: body.project,
      token: body.token,
      nodeId: "authored-copy",
      session: "clone-session",
      proof: "clone-proof",
      nonce: "authored-copy-dispatch",
    });

    const enqueued = await app.inject({
      method: "POST",
      url: `/api/p/${body.project}/fleet-requests`,
      headers: { "x-mg-token": body.token },
      payload: { node_id: "authored-copy" },
    });

    expect(dispatch.dispatched.statusCode).toBe(200);
    expect(enqueued.statusCode).toBe(400);
    expect(enqueued.json()).toMatchObject({ error: { code: "template_mismatch" } });
  });

  it("rejects an exact-copy task authored after the clone baseline at claim", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", false);
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    addFleetNode(store, body.project, "authored-copy", "Build API", "Implement it.", false);
    registerBrowserSession(store, body.project, "clone-session", "clone-proof");
    const dispatch = await dispatchFleetNode(app, {
      project: body.project,
      token: body.token,
      nodeId: "authored-copy",
      session: "clone-session",
      proof: "clone-proof",
      nonce: "authored-copy-dispatch",
    });
    store.database.prepare(
      `INSERT INTO fleet_requests
        (id, project_id, node_id, status, outcome, note, created_at, adopted_at, finished_at)
       VALUES (?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL)`,
    ).run("authored-copy-request", body.project, "authored-copy", "2026-08-30T10:00:00.000Z");

    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    const stored = store.database
      .prepare("SELECT status, outcome FROM fleet_requests WHERE id = ?")
      .get("authored-copy-request");

    expect(dispatch.dispatched.statusCode).toBe(200);
    expect(claimed.statusCode).toBe(204);
    expect(stored).toEqual({ status: "failed", outcome: "template_mismatch" });
  });

  it("rejects a split child created after the clone baseline", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", false);
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    const parent = store.listEvents(body.project).find((event) => event.type === "TASK_ADDED");
    if (!parent || parent.type !== "TASK_ADDED") throw new Error("cloned task missing");
    store.append(body.project, {
      actor: "human",
      type: "TASK_SPLIT",
      payload: {
        parent_id: parent.payload.node.id,
        children: [
          {
            id: "split-child",
            title: "Build API",
            brief: "Implement it.",
            estimate_min: 12,
            tags: ["fleet"],
            state: "queued",
          },
        ],
        edge_remap: [],
      },
      idem_key: "split-template",
    });
    registerBrowserSession(store, body.project, "clone-session", "clone-proof");
    const dispatch = await dispatchFleetNode(app, {
      project: body.project,
      token: body.token,
      nodeId: "split-child",
      session: "clone-session",
      proof: "clone-proof",
      nonce: "split-child-dispatch",
    });

    const enqueued = await app.inject({
      method: "POST",
      url: `/api/p/${body.project}/fleet-requests`,
      headers: { "x-mg-token": body.token },
      payload: { node_id: "split-child" },
    });

    expect(dispatch.dispatched.statusCode).toBe(200);
    expect(enqueued.statusCode).toBe(400);
    expect(enqueued.json()).toMatchObject({ error: { code: "template_mismatch" } });
  });

  it("accepts an inherited template task with a fresh confirmed dispatch", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", false);
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    const inherited = store.listEvents(body.project).find((event) => event.type === "TASK_ADDED");
    if (!inherited || inherited.type !== "TASK_ADDED") throw new Error("cloned task missing");
    registerBrowserSession(store, body.project, "clone-session", "clone-proof");
    const dispatch = await dispatchFleetNode(app, {
      project: body.project,
      token: body.token,
      nodeId: inherited.payload.node.id,
      session: "clone-session",
      proof: "clone-proof",
      nonce: "inherited-task-dispatch",
    });

    const enqueued = await app.inject({
      method: "POST",
      url: `/api/p/${body.project}/fleet-requests`,
      headers: { "x-mg-token": body.token },
      payload: { node_id: inherited.payload.node.id },
    });
    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });

    expect(dispatch.dispatched.statusCode).toBe(200);
    expect(enqueued.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ project_id: body.project, node_id: inherited.payload.node.id });
  });

  it("rejects a post-clone dispatch authorized by a capability consumed in another clone", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", false);
    const sourceClone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const source = sourceClone.json<{ project: string; token: string }>();
    const sourceTask = store.listEvents(source.project).find((event) => event.type === "TASK_ADDED");
    if (!sourceTask || sourceTask.type !== "TASK_ADDED") throw new Error("source cloned task missing");
    registerBrowserSession(store, source.project, "source-session", "source-proof");
    const sourceDispatch = await dispatchFleetNode(app, {
      project: source.project,
      token: source.token,
      nodeId: sourceTask.payload.node.id,
      session: "source-session",
      proof: "source-proof",
      nonce: "source-dispatch-use",
    });
    expect(sourceDispatch.dispatched.statusCode).toBe(200);
    const sourceAuthorization = store.listEvents(source.project).at(-1);
    if (!sourceAuthorization || sourceAuthorization.type !== "DISPATCHED" || !sourceAuthorization.payload.authorization) {
      throw new Error("source dispatch authorization missing");
    }

    const targetClone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const target = targetClone.json<{ project: string; token: string }>();
    const targetTask = store.listEvents(target.project).find((event) => event.type === "TASK_ADDED");
    if (!targetTask || targetTask.type !== "TASK_ADDED") throw new Error("target cloned task missing");
    store.append(target.project, {
      actor: "human",
      type: "DISPATCHED",
      payload: {
        node_id: targetTask.payload.node.id,
        bypass_cap: true,
        authorization: sourceAuthorization.payload.authorization,
      },
      idem_key: "foreign-authorized-dispatch",
    });

    const enqueued = await app.inject({
      method: "POST",
      url: `/api/p/${target.project}/fleet-requests`,
      headers: { "x-mg-token": target.token },
      payload: { node_id: targetTask.payload.node.id },
    });

    expect(enqueued.statusCode).toBe(400);
    expect(enqueued.json()).toMatchObject({ error: { code: "node_not_dispatched" } });
  });

  it("revalidates clone-local capability consumption when claiming a fleet request", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    addFleetNode(store, "seed", "template", "Build API", "Implement it.", false);
    const clone = await app.inject({ method: "POST", url: "/api/clone-demo" });
    const body = clone.json<{ project: string; token: string }>();
    const clonedTask = store.listEvents(body.project).find((event) => event.type === "TASK_ADDED");
    if (!clonedTask || clonedTask.type !== "TASK_ADDED") throw new Error("cloned task missing");
    registerBrowserSession(store, body.project, "clone-session", "clone-proof");
    const dispatch = await dispatchFleetNode(app, {
      project: body.project,
      token: body.token,
      nodeId: clonedTask.payload.node.id,
      session: "clone-session",
      proof: "clone-proof",
      nonce: "clone-dispatch-use",
    });
    expect(dispatch.dispatched.statusCode).toBe(200);
    const enqueued = await app.inject({
      method: "POST",
      url: `/api/p/${body.project}/fleet-requests`,
      headers: { "x-mg-token": body.token },
      payload: { node_id: clonedTask.payload.node.id },
    });
    const request = enqueued.json<{ id: string }>();
    expect(enqueued.statusCode).toBe(200);
    store.database
      .prepare("DELETE FROM human_capability_uses WHERE capability_ref = ? AND nonce = ?")
      .run(dispatch.capability.capability_ref, "clone-dispatch-use");

    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    const stored = store.database
      .prepare("SELECT status, outcome FROM fleet_requests WHERE id = ?")
      .get(request.id);

    expect(claimed.statusCode).toBe(204);
    expect(stored).toEqual({ status: "failed", outcome: "stale" });
  });

  it("rejects an edited brief that no longer matches the seed template", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    store.createProject("project", "visitor-token", "2026-08-30T09:30:00.000Z", { seedProjectId: "seed" });
    addFleetNode(store, "seed", "template", "Build API", "Original brief.", false);
    addFleetNode(store, "project", "task", "Build API", "Edited brief.", true);

    const response = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "template_mismatch" } });
  });

  it("rejects a dispatched brief_override at enqueue even when it equals the canonical brief", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    store.createProject("seed", "seed-token", "2026-08-30T09:00:00.000Z");
    store.createProject("project", "visitor-token", "2026-08-30T09:30:00.000Z", { seedProjectId: "seed" });
    addFleetNode(store, "seed", "template", "Build API", "Canonical brief.", false);
    addFleetNode(store, "project", "task", "Build API", "Canonical brief.", true, "Canonical brief.");

    const response = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "template_mismatch",
        message: expect.stringContaining("brief_override"),
      },
    });
  });

  it("rejects a queued brief_override during claim revalidation and continues to the next item", async () => {
    const clock = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({
      fleetMode: true,
      seedProjectId: "seed",
      fleetPerProjectCap: 2,
      now: () => clock,
    });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "eligible", title: "Build API", brief: "Canonical brief." },
    ]);
    addFleetNode(store, "project", "overridden", "Build API", "Canonical brief.", true, "Canonical brief.");
    store.database.prepare(
      `INSERT INTO fleet_requests
        (id, project_id, node_id, status, outcome, note, created_at, adopted_at, finished_at)
       VALUES (?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL)`,
    ).run("overridden-request", "project", "overridden", "2026-08-30T09:59:00.000Z");
    const enqueued = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "eligible" },
    });

    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });

    expect(claimed.json()).toMatchObject({ request_id: enqueued.json<{ id: string }>().id, node_id: "eligible" });
    expect(
      store.database
        .prepare("SELECT status, outcome, note FROM fleet_requests WHERE id = ?")
        .get("overridden-request"),
    ).toEqual({
      status: "failed",
      outcome: "template_mismatch",
      note: expect.stringContaining("brief_override"),
    });
  });

  it("rejects a template node that has not been dispatched", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    await prepareFleet(app, store, [
      {
        project: "project",
        token: "visitor-token",
        nodeId: "task",
        title: "Build API",
        brief: "Implement it.",
        dispatched: false,
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "node_not_dispatched" } });
  });

  it("enforces the project cap and refunds it after adoption expires", async () => {
    let clock = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({
      fleetMode: true,
      seedProjectId: "seed",
      fleetPerProjectCap: 1,
      fleetAdoptTtlMin: 1,
      now: () => clock,
    });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "a", title: "Task A", brief: "Build A." },
      { project: "project", token: "visitor-token", nodeId: "b", title: "Task B", brief: "Build B." },
    ]);
    const enqueue = (nodeId: string) => app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: nodeId },
    });

    const first = await enqueue("a");
    const capped = await enqueue("b");
    await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:01:01.000Z");
    const fleetStatus = await app.inject({
      method: "GET",
      url: "/api/p/project/fleet-status",
      headers: { "x-mg-token": "visitor-token" },
    });
    const refunded = await enqueue("b");

    expect(first.statusCode).toBe(200);
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: { code: "fleet_project_cap" } });
    expect(fleetStatus.json()).toMatchObject({ enabled: true, project_remaining: 1 });
    expect(refunded.statusCode).toBe(200);
  });

  it("enforces the global UTC daily fleet cap", async () => {
    const { app, store } = server({
      fleetMode: true,
      seedProjectId: "seed",
      fleetDailyCap: 1,
      fleetPerProjectCap: 2,
      now: () => new Date("2026-08-30T23:59:00.000Z"),
    });
    await prepareFleet(app, store, [
      { project: "project-a", token: "visitor-a", nodeId: "a", title: "Task A", brief: "Build A." },
      { project: "project-b", token: "visitor-b", nodeId: "b", title: "Task B", brief: "Build B." },
    ]);
    const first = await app.inject({
      method: "POST",
      url: "/api/p/project-a/fleet-requests",
      headers: { "x-mg-token": "visitor-a" },
      payload: { node_id: "a" },
    });
    const capped = await app.inject({
      method: "POST",
      url: "/api/p/project-b/fleet-requests",
      headers: { "x-mg-token": "visitor-b" },
      payload: { node_id: "b" },
    });

    expect(first.statusCode).toBe(200);
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: { code: "fleet_daily_cap" } });
  });

  it("returns a conflict for a duplicate active fleet request", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "task", title: "Build API", brief: "Implement it." },
    ]);
    const enqueue = () => app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });

    await enqueue();
    const duplicate = await enqueue();

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "fleet_request_exists" } });
  });

  it("marks a stale queued item failed and claims the next eligible item atomically", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed", fleetPerProjectCap: 2 });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "a", title: "Task A", brief: "Build A." },
      { project: "project", token: "visitor-token", nodeId: "b", title: "Task B", brief: "Build B." },
    ]);
    const enqueue = async (nodeId: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/p/project/fleet-requests",
        headers: { "x-mg-token": "visitor-token" },
        payload: { node_id: nodeId },
      });
      return response.json<{ id: string }>();
    };
    const stale = await enqueue("a");
    const eligible = await enqueue("b");
    store.append("project", {
      actor: "human",
      type: "TASK_REMOVED",
      payload: { node_id: "a", tombstone: true },
      idem_key: "a-undispatched",
    });

    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    const staleStatus = await app.inject({
      method: "GET",
      url: `/api/p/project/fleet-requests/${stale.id}`,
      headers: { "x-mg-token": "visitor-token" },
    });

    expect(claimed.json()).toMatchObject({ request_id: eligible.id, node_id: "b" });
    expect(staleStatus.json()).toMatchObject({ id: stale.id, status: "failed", outcome: "stale" });
  });

  it("keeps a heartbeating request alive past its original adoption TTL", async () => {
    let clock = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({
      fleetMode: true,
      seedProjectId: "seed",
      fleetAdoptTtlMin: 1,
      now: () => clock,
    });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "task", title: "Build API", brief: "Implement it." },
    ]);
    const enqueued = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });
    const { id: requestId } = enqueued.json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:00:45.000Z");
    await app.inject({
      method: "POST",
      url: `/api/fleet/${requestId}/heartbeat`,
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:01:30.000Z");
    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/fleet/${requestId}/heartbeat`,
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:02:15.000Z");

    const status = await app.inject({
      method: "GET",
      url: `/api/p/project/fleet-requests/${requestId}`,
      headers: { "x-mg-token": "visitor-token" },
    });

    expect(heartbeat.statusCode).toBe(200);
    expect(status.json()).toEqual({
      id: requestId,
      status: "running",
      adopted_at: "2026-08-30T10:01:30.000Z",
    });
  });

  it("expires an adopted request after a full TTL of silence", async () => {
    let clock = new Date("2026-08-30T10:00:00.000Z");
    const { app, store } = server({
      fleetMode: true,
      seedProjectId: "seed",
      fleetAdoptTtlMin: 1,
      now: () => clock,
    });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "task", title: "Build API", brief: "Implement it." },
    ]);
    const enqueued = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-token": "visitor-token" },
      payload: { node_id: "task" },
    });
    const { id: requestId } = enqueued.json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });
    clock = new Date("2026-08-30T10:01:01.000Z");

    const status = await app.inject({
      method: "GET",
      url: `/api/p/project/fleet-requests/${requestId}`,
      headers: { "x-mg-token": "visitor-token" },
    });

    expect(status.json()).toEqual({
      id: requestId,
      status: "expired",
      adopted_at: "2026-08-30T10:00:00.000Z",
      finished_at: "2026-08-30T10:01:01.000Z",
    });
  });

  it("rejects queued and terminal fleet heartbeats without changing timestamps", async () => {
    const { app, store } = server({
      fleetMode: true,
      now: () => new Date("2026-08-30T10:05:00.000Z"),
    });
    const states = ["queued", "done", "failed", "expired"] as const;
    const insert = store.database.prepare(
      `INSERT INTO fleet_requests
        (id, project_id, node_id, status, outcome, note, created_at, adopted_at, finished_at)
       VALUES (?, 'project', ?, ?, NULL, NULL, ?, ?, ?)`,
    );
    for (const status of states) {
      insert.run(
        `${status}-request`,
        `${status}-node`,
        status,
        "2026-08-30T09:00:00.000Z",
        status === "queued" ? null : "2026-08-30T09:10:00.000Z",
        status === "queued" ? null : "2026-08-30T09:20:00.000Z",
      );
    }
    const before = store.database
      .prepare("SELECT id, status, created_at, adopted_at, finished_at FROM fleet_requests ORDER BY id")
      .all();

    const responses = await Promise.all(states.map((status) => app.inject({
      method: "POST",
      url: `/api/fleet/${status}-request/heartbeat`,
      headers: { "x-mg-reporter": "reporter-secret" },
    })));
    const after = store.database
      .prepare("SELECT id, status, created_at, adopted_at, finished_at FROM fleet_requests ORDER BY id")
      .all();

    expect(responses.map((response) => response.statusCode)).toEqual([409, 409, 409, 409]);
    expect(responses.map((response) => response.json())).toEqual(states.map((status) => ({
      error: { code: "fleet_request_state", message: `Fleet request is ${status}.` },
    })));
    expect(after).toEqual(before);
  });

  it("rejects visitor credentials on supervisor fleet routes", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "task", title: "Build API", brief: "Implement it." },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-token": "visitor-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("rejects supervisor credentials on visitor fleet routes", async () => {
    const { app, store } = server({ fleetMode: true, seedProjectId: "seed" });
    await prepareFleet(app, store, [
      { project: "project", token: "visitor-token", nodeId: "task", title: "Build API", brief: "Implement it." },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/p/project/fleet-requests",
      headers: { "x-mg-reporter": "reporter-secret" },
      payload: { node_id: "task" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("keeps fleet status probeable while every other fleet route is disabled", async () => {
    const { app, store } = server({ fleetMode: false });
    store.createProject("project", "visitor-token", "2026-08-30T09:30:00.000Z");
    const status = await app.inject({
      method: "GET",
      url: "/api/p/project/fleet-status",
      headers: { "x-mg-token": "visitor-token" },
    });
    const disabled = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/p/project/fleet-requests",
        headers: { "x-mg-token": "visitor-token" },
        payload: { node_id: "task" },
      }),
      app.inject({
        method: "GET",
        url: "/api/p/project/fleet-requests/request",
        headers: { "x-mg-token": "visitor-token" },
      }),
      app.inject({ method: "POST", url: "/api/fleet/next", headers: { "x-mg-reporter": "reporter-secret" } }),
      app.inject({
        method: "POST",
        url: "/api/fleet/request/heartbeat",
        headers: { "x-mg-reporter": "reporter-secret" },
      }),
      app.inject({
        method: "POST",
        url: "/api/fleet/request/complete",
        headers: { "x-mg-reporter": "reporter-secret" },
        payload: { outcome: "done" },
      }),
    ]);

    expect(status.json()).toEqual({ enabled: false, queue_depth: 0, daily_remaining: 0, project_remaining: 0 });
    for (const response of disabled) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "fleet_disabled" } });
    }
  });

  it("defaults fleet mode off when FLEET_MODE is absent", async () => {
    const previous = process.env.FLEET_MODE;
    delete process.env.FLEET_MODE;
    try {
      const { app, store } = server();
      store.createProject("project", "visitor-token", "2026-08-30T09:30:00.000Z");
      const status = await app.inject({
        method: "GET",
        url: "/api/p/project/fleet-status",
        headers: { "x-mg-token": "visitor-token" },
      });
      const disabled = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/p/project/fleet-requests",
          headers: { "x-mg-token": "visitor-token" },
          payload: { node_id: "task" },
        }),
        app.inject({
          method: "GET",
          url: "/api/p/project/fleet-requests/request",
          headers: { "x-mg-token": "visitor-token" },
        }),
        app.inject({ method: "POST", url: "/api/fleet/next", headers: { "x-mg-reporter": "reporter-secret" } }),
        app.inject({
          method: "POST",
          url: "/api/fleet/request/heartbeat",
          headers: { "x-mg-reporter": "reporter-secret" },
        }),
        app.inject({
          method: "POST",
          url: "/api/fleet/request/complete",
          headers: { "x-mg-reporter": "reporter-secret" },
          payload: { outcome: "done" },
        }),
      ]);

      expect(status.json()).toEqual({ enabled: false, queue_depth: 0, daily_remaining: 0, project_remaining: 0 });
      for (const response of disabled) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: "fleet_disabled" } });
      }
    } finally {
      if (previous === undefined) delete process.env.FLEET_MODE;
      else process.env.FLEET_MODE = previous;
    }
  });

  it("ignores invalid fleet-only settings while disabled and validates each setting while enabled", () => {
    const names = ["FLEET_MODE", "FLEET_DAILY_CAP", "FLEET_PER_PROJECT_CAP", "FLEET_ADOPT_TTL_MIN"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.FLEET_MODE = "0";
      process.env.FLEET_DAILY_CAP = "0";
      process.env.FLEET_PER_PROJECT_CAP = "0";
      process.env.FLEET_ADOPT_TTL_MIN = "0";
      expect(() => server()).not.toThrow();

      for (const name of names.slice(1)) {
        process.env.FLEET_MODE = "1";
        delete process.env.FLEET_DAILY_CAP;
        delete process.env.FLEET_PER_PROJECT_CAP;
        delete process.env.FLEET_ADOPT_TTL_MIN;
        process.env[name] = "0";
        expect(() => server()).toThrow(`${name} must be a positive integer`);
      }
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("returns enabled fleet capacity and 204 when the queue is empty", async () => {
    const { app, store } = server({
      fleetMode: true,
      seedProjectId: "seed",
      fleetDailyCap: 7,
      fleetPerProjectCap: 3,
    });
    store.createProject("project", "visitor-token", "2026-08-30T09:30:00.000Z");
    const status = await app.inject({
      method: "GET",
      url: "/api/p/project/fleet-status",
      headers: { "x-mg-token": "visitor-token" },
    });
    const next = await app.inject({
      method: "POST",
      url: "/api/fleet/next",
      headers: { "x-mg-reporter": "reporter-secret" },
    });

    expect(status.json()).toEqual({ enabled: true, queue_depth: 0, daily_remaining: 7, project_remaining: 3 });
    expect(next.statusCode).toBe(204);
  });
});
