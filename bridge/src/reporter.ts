import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "./config.js";

export interface ReporterEvent {
  actor: "supervisor" | `worker:${string}`;
  type: string;
  payload: Record<string, unknown>;
  idem_key: string;
}

export function reporterPayload(
  actor: ReporterEvent["actor"],
  type: string,
  payload: Record<string, unknown>,
  idemKey: string = randomUUID(),
): ReporterEvent {
  return { actor, type, payload, idem_key: idemKey };
}

export class ReporterClient {
  constructor(private readonly config: BridgeConfig) {}

  get url(): string {
    return `${this.config.serverUrl}/api/p/${encodeURIComponent(this.config.projectId)}/report`;
  }

  async post(event: ReporterEvent): Promise<number> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.reporterCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`reporter POST failed (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as { seq?: unknown };
    if (!Number.isSafeInteger(body.seq)) throw new Error("reporter POST response did not contain a sequence");
    return body.seq as number;
  }
}
