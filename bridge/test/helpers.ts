import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeConfig } from "../src/config.js";
import type { Logger, MissionEvent } from "../src/types.js";

export class TestLogger implements Logger {
  readonly infoMessages: string[] = [];
  readonly warningMessages: string[] = [];
  readonly errorMessages: string[] = [];

  info(message: string): void {
    this.infoMessages.push(message);
  }

  warn(message: string): void {
    this.warningMessages.push(message);
  }

  error(message: string): void {
    this.errorMessages.push(message);
  }
}

export function event(seq: number, type = "DISPATCHED", payload: Record<string, unknown> = {}): MissionEvent {
  return {
    seq,
    project_id: "project",
    ts: `2026-08-30T10:00:${String(seq).padStart(2, "0")}.000Z`,
    actor: "human",
    type,
    payload,
    idem_key: `event-${seq}`,
  };
}

export function config(root: string, repoPath = join(root, "repo")): BridgeConfig {
  return {
    serverUrl: "http://127.0.0.1:3000",
    projectId: "project",
    visitorToken: "visitor-token",
    reporterCredential: "reporter-token",
    targetRepoPath: repoPath,
    codexBinaryPath: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  codexSandbox: "workspace-write",
    statePath: join(root, "state.json"),
    fleetMode: false,
    fleetPollMs: 15_000,
    fleetRunTtlMs: 15 * 60_000,
    fleetHeartbeatMs: 45_000,
  };
}

export async function initializeRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "seed.txt"), "seed\n");
  for (const args of [
    ["init", "-q", path],
    ["-C", path, "config", "user.name", "MissionGraph Test"],
    ["-C", path, "config", "user.email", "missiongraph@example.test"],
    ["-C", path, "add", "seed.txt"],
    ["-C", path, "commit", "-q", "-m", "test: seed repository"],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}
