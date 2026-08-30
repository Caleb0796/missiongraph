import type { BridgeConfig } from "./config.js";
import type { Logger, MissionEvent } from "./types.js";

function eventMessage(value: unknown): MissionEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as { kind?: unknown; event?: unknown };
  if (message.kind !== "event" || typeof message.event !== "object" || message.event === null) return undefined;
  const event = message.event as Partial<MissionEvent>;
  if (!Number.isSafeInteger(event.seq) || typeof event.type !== "string" || typeof event.payload !== "object") {
    return undefined;
  }
  return event as MissionEvent;
}

function messages(block: string): unknown[] {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return [];
  try {
    return [JSON.parse(data)];
  } catch {
    return [];
  }
}

export async function streamEvents(
  config: BridgeConfig,
  initialCursor: string,
  signal: AbortSignal,
  onEvent: (event: MissionEvent) => void,
  logger: Logger,
): Promise<void> {
  let streamCursor = initialCursor;
  while (!signal.aborted) {
    try {
      const url = new URL("/sse", config.serverUrl);
      url.searchParams.set("project", config.projectId);
      url.searchParams.set("token", config.visitorToken);
      url.searchParams.set("from_seq", streamCursor);
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error(`SSE connection failed (${response.status})`);
      logger.info(`SSE connected after cursor ${streamCursor}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const message of messages(block)) {
            const event = eventMessage(message);
            if (!event) continue;
            streamCursor = String(event.seq);
            onEvent(event);
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      logger.warn(`SSE disconnected: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}
