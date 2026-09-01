import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgeConfig {
  serverUrl: string;
  projectId: string;
  visitorToken: string;
  reporterCredential: string;
  targetRepoPath: string;
  codexBinaryPath: string;
  model: string;
  effort: string;
  statePath: string;
  fleetMode: boolean;
  fleetPollMs: number;
  fleetRunTtlMs: number;
  fleetHeartbeatMs: number;
}

interface FileConfig {
  server_url?: string;
  project_id?: string;
  visitor_token?: string;
  reporter_credential?: string;
  target_repo_path?: string;
  codex_binary_path?: string;
  model?: string;
  effort?: string;
  state_path?: string;
  fleet_mode?: boolean | number | string;
}

export function resolveBridgePackageRoot(moduleUrl: string): string {
  let candidate = dirname(fileURLToPath(moduleUrl));
  const root = parse(candidate).root;
  while (candidate !== root) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
    candidate = dirname(candidate);
  }
  throw new Error(`could not resolve bridge package root from ${moduleUrl}`);
}

export const bridgePackageRoot = resolveBridgePackageRoot(import.meta.url);

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function choose(envName: string, fileValue: string | undefined): string | undefined {
  return process.env[envName] || fileValue;
}

function fleetEnabled(fileValue: FileConfig["fleet_mode"]): boolean {
  const value = process.env.FLEET_MODE ?? fileValue;
  return value === true || value === 1 || value === "1";
}

function durationMs(envName: "FLEET_POLL_SEC" | "FLEET_RUN_TTL_MIN", fallback: number, scale: number): number {
  const value = process.env[envName];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${envName} must be a positive number`);
  return parsed * scale;
}

export async function loadConfig(path = resolve(bridgePackageRoot, "config.json")): Promise<BridgeConfig> {
  let file: FileConfig = {};
  try {
    file = JSON.parse(await readFile(path, "utf8")) as FileConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const serverUrl = required(choose("MG_SERVER_URL", file.server_url), "MG_SERVER_URL or server_url");
  const parsedServerUrl = new URL(serverUrl);
  if (!(["http:", "https:"] as string[]).includes(parsedServerUrl.protocol)) {
    throw new Error("server URL must use http or https");
  }
  const fleetMode = fleetEnabled(file.fleet_mode);
  return {
    serverUrl: serverUrl.replace(/\/$/, ""),
    projectId: required(choose("MG_PROJECT_ID", file.project_id), "MG_PROJECT_ID or project_id"),
    visitorToken: required(choose("MG_VISITOR_TOKEN", file.visitor_token), "MG_VISITOR_TOKEN or visitor_token"),
    reporterCredential: required(
      choose("MG_REPORTER_CREDENTIAL", file.reporter_credential),
      "MG_REPORTER_CREDENTIAL or reporter_credential",
    ),
    targetRepoPath: resolve(
      required(choose("MG_TARGET_REPO", file.target_repo_path), "MG_TARGET_REPO or target_repo_path"),
    ),
    codexBinaryPath: choose("MG_CODEX_PATH", file.codex_binary_path) ?? "codex",
    model: choose("MG_CODEX_MODEL", file.model) ?? "gpt-5.6-sol",
    effort: choose("MG_CODEX_EFFORT", file.effort) ?? "high",
    statePath: resolve(choose("MG_BRIDGE_STATE", file.state_path) ?? resolve(bridgePackageRoot, "state.json")),
    fleetMode,
    fleetPollMs: fleetMode ? durationMs("FLEET_POLL_SEC", 15_000, 1_000) : 15_000,
    fleetRunTtlMs: fleetMode ? durationMs("FLEET_RUN_TTL_MIN", 15 * 60_000, 60_000) : 15 * 60_000,
    fleetHeartbeatMs: 45_000,
  };
}
