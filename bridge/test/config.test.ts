import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgePackageRoot, loadConfig, resolveBridgePackageRoot } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("bridge package root", () => {
  it("resolves source and compiled module paths to the package root", () => {
    const expected = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const sourceUrl = pathToFileURL(join(expected, "src", "config.ts")).href;
    const compiledUrl = pathToFileURL(join(expected, "dist", "src", "config.js")).href;

    expect(bridgePackageRoot).toBe(expected);
    expect(resolveBridgePackageRoot(sourceUrl)).toBe(expected);
    expect(resolveBridgePackageRoot(compiledUrl)).toBe(expected);
  });

  it("accepts fleet_mode from config while defaulting fleet timings", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-config-"));
    const path = join(root, "config.json");
    try {
      await writeFile(path, JSON.stringify({
        server_url: "http://127.0.0.1:3000",
        project_id: "project",
        visitor_token: "visitor",
        reporter_credential: "reporter",
        target_repo_path: root,
        fleet_mode: true,
      }));
      const loaded = await loadConfig(path);
      expect(loaded).toMatchObject({
        fleetMode: true,
        fleetPollMs: 15_000,
        fleetRunTtlMs: 15 * 60_000,
        fleetHeartbeatMs: 45_000,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets FLEET_MODE=0 disable a true config value and parses timing overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-config-env-"));
    const path = join(root, "config.json");
    vi.stubEnv("FLEET_MODE", "0");
    vi.stubEnv("FLEET_POLL_SEC", "2.5");
    vi.stubEnv("FLEET_RUN_TTL_MIN", "3");
    try {
      await writeFile(path, JSON.stringify({
        server_url: "http://127.0.0.1:3000",
        project_id: "project",
        visitor_token: "visitor",
        reporter_credential: "reporter",
        target_repo_path: root,
        fleet_mode: true,
      }));
      const loaded = await loadConfig(path);
      expect(loaded).toMatchObject({ fleetMode: false, fleetPollMs: 2_500, fleetRunTtlMs: 180_000 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-positive fleet timing overrides", async () => {
    vi.stubEnv("FLEET_POLL_SEC", "0");
    vi.stubEnv("MG_SERVER_URL", "http://127.0.0.1:3000");
    vi.stubEnv("MG_PROJECT_ID", "project");
    vi.stubEnv("MG_VISITOR_TOKEN", "visitor");
    vi.stubEnv("MG_REPORTER_CREDENTIAL", "reporter");
    vi.stubEnv("MG_TARGET_REPO", "/tmp/repo");
    await expect(loadConfig("/does-not-exist.json")).rejects.toThrow("FLEET_POLL_SEC must be a positive number");
  });
});
