import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";

import type { Event, EventStore } from "./events.js";
import { fold } from "./reducer.js";

type MissionSocket = WebSocket & { missionContext: { project: string; fromSeq?: number } };

function cursor(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function websocketError(socket: import("node:stream").Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function installRealtime(app: FastifyInstance, store: EventStore): void {
  const sockets = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return;
    const project = url.searchParams.get("project");
    const token = url.searchParams.get("token");
    const rawFrom = url.searchParams.get("from_seq");
    const fromSeq = cursor(rawFrom);
    if (!project || !token || !store.tokenMatches(project, token)) {
      websocketError(socket, 401, "Unauthorized");
      return;
    }
    if (rawFrom !== null && fromSeq === undefined) {
      websocketError(socket, 400, "Bad Request");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const missionSocket = websocket as MissionSocket;
      missionSocket.missionContext = { project, ...(fromSeq === undefined ? {} : { fromSeq }) };
      sockets.emit("connection", missionSocket, request);
    });
  });

  sockets.on("connection", (websocket) => {
    const socket = websocket as MissionSocket;
    const context = socket.missionContext;
    const send = (message: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const live = (event: Event): void => {
      if (event.project_id === context.project) send({ kind: "event", event });
    };
    store.events.on("event", live);
    if (context.fromSeq === undefined) {
      const events = store.listEvents(context.project);
      send({ kind: "snapshot", state: fold(events), cursor: String(events.at(-1)?.seq ?? 0) });
    } else {
      for (const event of store.listEvents(context.project, context.fromSeq)) {
        send({ kind: "event", event });
      }
    }
    socket.once("close", () => store.events.off("event", live));
  });

  app.get("/sse", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const project = typeof query.project === "string" ? query.project : undefined;
    const token = typeof query.token === "string" ? query.token : undefined;
    const rawFrom = typeof query.from_seq === "string" ? query.from_seq : null;
    const fromSeq = cursor(rawFrom);
    if (!project || !token || !store.tokenMatches(project, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (rawFrom !== null && fromSeq === undefined) {
      return reply.code(400).send({ error: "from_seq must be a non-negative integer" });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (message: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
    };
    const live = (event: Event): void => {
      if (event.project_id === project) send({ kind: "event", event });
    };
    store.events.on("event", live);
    // A quiet mission produces no events for minutes at a time, and HTTP clients
    // (the bridge's undici fetch included) time out an idle body after ~5 minutes —
    // observed on the VM as a disconnect/reconnect cycle every five minutes. An SSE
    // comment line is ignored by every consumer and keeps the stream visibly alive.
    const keepalive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": keepalive\n\n");
    }, 25_000);
    if (fromSeq === undefined) {
      const events = store.listEvents(project);
      send({ kind: "snapshot", state: fold(events), cursor: String(events.at(-1)?.seq ?? 0) });
    } else {
      for (const event of store.listEvents(project, fromSeq)) send({ kind: "event", event });
    }
    request.raw.once("close", () => {
      clearInterval(keepalive);
      store.events.off("event", live);
    });
  });

  app.addHook("onClose", async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  });
}
