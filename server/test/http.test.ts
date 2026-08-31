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
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("applies mutation batches atomically with server-assigned ids", async () => {
    const assignedIds = ["node-a", "node-b", "edge-a-b"];
    const { app, store } = server({ id: () => assignedIds.shift() ?? "unexpected-id" });
    store.createProject("project", "visitor-token", "2026-08-30T10:00:00.000Z");
    const invalid = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: { "x-mg-token": "visitor-token", "x-mg-actor": "browser_agent" },
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
      url: "/api/p/project/mutations",
      headers: { "x-mg-token": "visitor-token", "x-mg-actor": "browser_agent" },
      payload: validPayload,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: { "x-mg-token": "visitor-token", "x-mg-actor": "browser_agent" },
      payload: validPayload,
    });

    expect(valid.json()).toEqual({ seqs: [1, 2, 3] });
    expect(duplicate.json()).toEqual({ seqs: [1, 2, 3] });
    expect(store.listEvents("project")).toMatchObject([
      { type: "TASK_ADDED", payload: { node: { id: "node-a" } } },
      { type: "TASK_ADDED", payload: { node: { id: "node-b" } } },
      {
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

  it("binds approval policies to the browser session that stated them", async () => {
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
    store.append("project", {
      actor: "worker:a",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "a", from: "queued", to: "running" },
      idem_key: "running-a",
    });
    store.append("project", {
      actor: "worker:a",
      type: "HANDOFF_FILED",
      payload: { node_id: "a", handoff: baseHandoff },
      idem_key: "handoff-a",
    });
    store.append("project", {
      actor: "supervisor",
      type: "APPROVAL_CREATED",
      payload: { approval_id: "approval-a", node_id: "a", summary: "Review task A." },
      idem_key: "approval-a",
    });
    const policy = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: { "x-mg-token": "visitor-token", "x-mg-session": "session-a" },
      payload: {
        type: "POLICY_STATED",
        payload: {
          policy_ref: "policy-a",
          text: "Approve green diffs.",
          scope: "session",
          session_id: "session-a",
        },
        idem_key: "policy-a",
      },
    });
    const foreignSession = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-actor": "browser_agent",
        "x-mg-session": "session-b",
      },
      payload: {
        type: "APPROVED",
        payload: { approval_id: "approval-a", node_id: "a", policy_ref: "policy-a" },
        idem_key: "foreign-approval",
      },
    });
    const owningSession = await app.inject({
      method: "POST",
      url: "/api/p/project/mutations",
      headers: {
        "x-mg-token": "visitor-token",
        "x-mg-actor": "browser_agent",
        "x-mg-session": "session-a",
      },
      payload: {
        type: "APPROVED",
        payload: { approval_id: "approval-a", node_id: "a", policy_ref: "policy-a" },
        idem_key: "owning-approval",
      },
    });

    expect(policy.json()).toEqual({ seq: 5 });
    expect(foreignSession.statusCode).toBe(400);
    expect(foreignSession.json()).toMatchObject({
      error: { message: "policy policy-a belongs to another browser session" },
    });
    expect(owningSession.json()).toEqual({ seq: 6 });
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
});
