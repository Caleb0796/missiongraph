import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "./config.js";

const reporterRequestTimeoutMs = 30_000;

export interface ReporterEvent {
  actor: "supervisor" | `worker:${string}`;
  type: string;
  payload: Record<string, unknown>;
  idem_key: string;
}

export interface ReporterCredential {
  token: string;
  actor: ReporterEvent["actor"];
  expires: string;
}

export class ReporterRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly responseMessage: string | undefined,
    responseBody: string,
  ) {
    super(`reporter POST failed (${status}): ${responseBody}`);
    this.name = "ReporterRequestError";
  }
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
  constructor(
    private readonly config: BridgeConfig,
    private readonly dryRun = false,
  ) {}

  get url(): string {
    return `${this.config.serverUrl}/api/p/${encodeURIComponent(this.config.projectId)}/report`;
  }

  async issue(actor: ReporterEvent["actor"], signal?: AbortSignal): Promise<ReporterCredential> {
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(reporterRequestTimeoutMs)])
      : AbortSignal.timeout(reporterRequestTimeoutMs);
    const response = await fetch(
      `${this.config.serverUrl}/api/p/${encodeURIComponent(this.config.projectId)}/reporter-credentials`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.reporterCredential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ actor }),
        signal: boundedSignal,
      },
    );
    if (!response.ok) {
      throw new Error(`reporter credential POST failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as Partial<ReporterCredential>;
    if (
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(body.token) ||
      body.actor !== actor ||
      typeof body.expires !== "string" ||
      !Number.isFinite(Date.parse(body.expires))
    ) {
      throw new Error("reporter credential response did not match the MissionGraph contract");
    }
    return body as ReporterCredential;
  }

  async post(event: ReporterEvent, signal?: AbortSignal): Promise<number> {
    const body = this.dryRun && event.type === "JOURNAL_NOTE" && typeof event.payload.text === "string"
      ? { ...event, payload: { ...event.payload, text: `DRY-RUN SIMULATION: ${event.payload.text}` } }
      : event;
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(reporterRequestTimeoutMs)])
      : AbortSignal.timeout(reporterRequestTimeoutMs);
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.reporterCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: boundedSignal,
    });
    if (!response.ok) {
      const responseBody = await response.text();
      let parsed: { error?: string | { code?: unknown; message?: unknown } } = {};
      try {
        parsed = JSON.parse(responseBody) as typeof parsed;
      } catch {
        // Keep the original response body in the error when an upstream proxy returns non-JSON.
      }
      const error = parsed.error;
      throw new ReporterRequestError(
        response.status,
        typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : undefined,
        typeof error === "string"
          ? error
          : typeof error === "object" && error !== null && typeof error.message === "string"
            ? error.message
            : undefined,
        responseBody,
      );
    }
    const responseBody = (await response.json()) as { seq?: unknown };
    if (!Number.isSafeInteger(responseBody.seq)) throw new Error("reporter POST response did not contain a sequence");
    return responseBody.seq as number;
  }
}
