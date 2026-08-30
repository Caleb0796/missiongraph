import { once } from "node:events";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { createServer, type MissionGraphServer, type ServerOptions } from "../src/http.js";

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

  it("clones the seed stream with fresh project and node ids", async () => {
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

  it("authenticates fleet reports separately from visitor mutations", async () => {
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
    const authorized = await app.inject({
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

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.json()).toEqual({ seq: 2 });
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
