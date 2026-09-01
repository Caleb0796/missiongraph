import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { streamEvents } from "../src/sse.js";
import type { MissionEvent } from "../src/types.js";
import { config, TestLogger } from "./helpers.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  })));
  servers.clear();
});

describe("streamEvents", () => {
  it("cancels a broken stream and reconnects with cursor-preserving backoff", async () => {
    const requests: Array<{ at: number; connection?: string; cursor?: string }> = [];
    const firstEvent: MissionEvent = {
      seq: 5,
      project_id: "project",
      ts: "2026-09-01T10:00:00.000Z",
      actor: "human",
      type: "DISPATCHED",
      payload: { node_id: "node-a" },
      idem_key: "event-5",
    };
    const secondEvent: MissionEvent = { ...firstEvent, seq: 6, idem_key: "event-6" };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({
        at: Date.now(),
        ...(request.headers.connection ? { connection: request.headers.connection } : {}),
        ...(url.searchParams.get("from_seq") ? { cursor: url.searchParams.get("from_seq")! } : {}),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ kind: "event", event: requests.length === 1 ? firstEvent : secondEvent })}\n\n`);
      if (requests.length === 1) setTimeout(() => response.destroy(), 20);
    });
    servers.add(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address() as AddressInfo;
    const bridgeConfig = {
      ...config("/tmp/missiongraph-sse"),
      serverUrl: `http://127.0.0.1:${address.port}`,
      visitorToken: "secret-visitor-token",
    };
    const controller = new AbortController();
    const logger = new TestLogger();
    const events: MissionEvent[] = [];

    await streamEvents(bridgeConfig, "4", controller.signal, (event) => {
      events.push(event);
      if (event.seq === 6) controller.abort();
    }, logger);

    expect(events.map((event) => event.seq)).toEqual([5, 6]);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.cursor)).toEqual(["4", "5"]);
    expect(requests.every((request) => request.connection === "close")).toBe(true);
    expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(450);
    expect(logger.warningMessages).toHaveLength(1);
    expect(logger.warningMessages[0]).toMatch(/\([A-Z][A-Z0-9_]+\)$/);
    expect(logger.warningMessages[0]).not.toContain(bridgeConfig.visitorToken);
  });
});
