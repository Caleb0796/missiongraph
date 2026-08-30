import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MissionGraphBridge } from "../src/bridge.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a test port");
  await new Promise<void>((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  return address.port;
}

async function cloneWhenReady(serverUrl: string): Promise<{ project: string; token: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/api/clone-demo`, { method: "POST" });
      if (response.ok) return (await response.json()) as { project: string; token: string };
      lastError = new Error(`clone returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw lastError;
}

async function mutation(
  serverUrl: string,
  project: string,
  token: string,
  type: string,
  payload: Record<string, unknown>,
  idemKey: string,
): Promise<number> {
  const response = await fetch(`${serverUrl}/api/p/${encodeURIComponent(project)}/mutations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mg-token": token },
    body: JSON.stringify({ type, payload, idem_key: idemKey }),
  });
  if (!response.ok) throw new Error(`mutation ${type} failed (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { seq: number }).seq;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

describe("bridge dry-run integration", () => {
  it(
    "streams a real server dispatch through a supervisor decision into a mock worker worktree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "missiongraph-integration-"));
      const port = await freePort();
      const reporterToken = "integration-reporter-token";
      const serverUrl = `http://127.0.0.1:${port}`;
      const server = spawn("pnpm", ["--dir", join(repositoryRoot, "server"), "exec", "tsx", "src/http.ts"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          REPORTER_TOKEN: reporterToken,
          DB_PATH: join(root, "integration.sqlite"),
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let serverStderr = "";
      server.stderr?.on("data", (chunk: Buffer) => {
        serverStderr += chunk.toString();
      });
      let bridge: MissionGraphBridge | undefined;
      try {
        const clone = await cloneWhenReady(serverUrl);
        const repoPath = join(root, "target-repo");
        await initializeRepo(repoPath);
        const bridgeConfig = {
          ...config(root, repoPath),
          serverUrl,
          projectId: clone.project,
          visitorToken: clone.token,
          reporterCredential: reporterToken,
        };
        bridge = new MissionGraphBridge(bridgeConfig, new TestLogger(), true);
        await bridge.start();

        await mutation(
          serverUrl,
          clone.project,
          clone.token,
          "TASK_ADDED",
          {
            node: {
              id: "smoke-node",
              title: "Smoke node",
              brief: "Exercise the bridge.",
              estimate_min: 1,
              tags: ["smoke"],
              state: "queued",
            },
          },
          "smoke-add",
        );
        await mutation(
          serverUrl,
          clone.project,
          clone.token,
          "DISPATCHED",
          { node_id: "smoke-node", bypass_cap: true },
          "smoke-dispatch",
        );

        for (let attempt = 0; attempt < 100 && !bridge.getState()?.workers["smoke-node"]; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        await bridge.whenIdle();
        expect(bridge.getState()).toMatchObject({
          cursor: "2",
          supervisor_thread_id: "mock-supervisor",
          workers: { "smoke-node": { thread_id: "mock-worker-smoke-node" } },
        });
      } finally {
        await bridge?.stop();
        await stopProcess(server);
        await rm(root, { recursive: true, force: true });
      }
      expect(serverStderr).not.toContain("Error:");
    },
    20_000,
  );
});
