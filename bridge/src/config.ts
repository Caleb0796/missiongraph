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
  };
}
