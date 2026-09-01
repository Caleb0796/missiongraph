import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

async function serverWhenReady(serverUrl: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
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

async function confirmedMutation(
  serverUrl: string,
  project: string,
  token: string,
  type: string,
  payload: Record<string, unknown>,
  idemKey: string,
): Promise<number> {
  const sessionResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(project)}/browser-sessions`, {
    method: "POST",
    headers: { "x-mg-token": token },
  });
  if (!sessionResponse.ok) {
    throw new Error(`browser session failed (${sessionResponse.status}): ${await sessionResponse.text()}`);
  }
  const session = (await sessionResponse.json()) as { session_id: string; session_proof: string };
  const sessionHeaders = {
    "x-mg-token": token,
    "x-mg-session": session.session_id,
    "x-mg-session-proof": session.session_proof,
  };
  const draftResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(project)}/action-drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...sessionHeaders },
    body: JSON.stringify({ mutation: { type, payload }, summary: `Confirm ${type} in the bridge integration test.` }),
  });
  if (!draftResponse.ok) {
    throw new Error(`action draft failed (${draftResponse.status}): ${await draftResponse.text()}`);
  }
  const draft = (await draftResponse.json()) as { draft_id: string };
  const confirmationResponse = await fetch(
    `${serverUrl}/api/p/${encodeURIComponent(project)}/action-drafts/${encodeURIComponent(draft.draft_id)}/confirm`,
    { method: "POST", headers: sessionHeaders },
  );
  if (!confirmationResponse.ok) {
    throw new Error(`action confirmation failed (${confirmationResponse.status}): ${await confirmationResponse.text()}`);
  }
  const capability = (await confirmationResponse.json()) as { capability_ref: string; capability: string };
  const response = await fetch(`${serverUrl}/api/p/${encodeURIComponent(project)}/mutations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...sessionHeaders,
      "x-mg-capability-ref": capability.capability_ref,
      "x-mg-capability": capability.capability,
      "x-mg-nonce": `bridge-integration-${idemKey}`,
    },
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
        const logger = new TestLogger();
        bridge = new MissionGraphBridge(bridgeConfig, logger, true, async (pid) => `test-start-${pid}`);
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
        await confirmedMutation(
          serverUrl,
          clone.project,
          clone.token,
          "DISPATCHED",
          { node_id: "smoke-node", bypass_cap: true },
          "smoke-dispatch",
        );
        await bridge.start();

        for (let attempt = 0; attempt < 100 && !bridge.getState()?.workers["smoke-node"]; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        await bridge.whenIdle();
        for (let attempt = 0; attempt < 100 && bridge.getState()?.workers["smoke-node"]?.status !== "idle"; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        expect(bridge.getState()).toMatchObject({
          cursor: "2",
          supervisor_thread_id: "mock-supervisor",
          workers: {
            "smoke-node": {
              status: "idle",
              thread_id: "mock-worker-smoke-node",
            },
          },
        });
        expect(bridge.getState()?.workers["smoke-node"]).not.toHaveProperty("reporter_credential");
        expect(bridge.getState()?.workers["smoke-node"]).not.toHaveProperty("reporter_expires");
        expect(bridge.getState()?.workers["smoke-node"]).not.toHaveProperty("reporter_config_path");

        await mutation(
          serverUrl,
          clone.project,
          clone.token,
          "ANNOTATED",
          { target_id: "smoke-node", note: "Record this supervisor observation." },
          "smoke-annotation",
        );
        for (let attempt = 0; attempt < 100 && bridge.getState()?.cursor !== "4"; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        await bridge.whenIdle();
        expect(bridge.getState()?.cursor).toBe("4");
        await mutation(
          serverUrl,
          clone.project,
          clone.token,
          "ANNOTATED",
          { target_id: "smoke-node", note: "MALFORMED_DECISION_TEST" },
          "smoke-malformed",
        );
        for (let attempt = 0; attempt < 100 && bridge.getState()?.cursor !== "6"; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        await bridge.whenIdle();
        expect(bridge.getState()?.cursor).toBe("6");
        const snapshot = await fetch(`${serverUrl}/api/p/${encodeURIComponent(clone.project)}/snapshot`, {
          headers: { "x-mg-token": clone.token },
        });
        const snapshotBody = await snapshot.json() as { state: { journal: { text: string }[] } };
        expect(snapshotBody.state.journal.map((entry) => entry.text)).toEqual([
          "DRY-RUN SIMULATION: Supervisor observed annotation for smoke-node.",
          expect.stringContaining("DRY-RUN SIMULATION: Supervisor decision was malformed for envelope seq 5-5"),
        ]);
        expect(logger.warningMessages).toEqual(expect.arrayContaining([
          expect.stringContaining("retrying malformed supervisor decision for envelope seq 5-5"),
        ]));
        expect(logger.errorMessages).toEqual([]);
      } finally {
        await bridge?.stop();
        await stopProcess(server);
        await rm(root, { recursive: true, force: true });
      }
      expect(serverStderr).not.toContain("Error:");
    },
    20_000,
  );

  it(
    "adopts a seeded clone through the real fleet server and detaches after reported worker lifecycle",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "missiongraph-fleet-integration-"));
      const port = await freePort();
      const reporterToken = "fleet-integration-reporter-token";
      const serverUrl = `http://127.0.0.1:${port}`;
      const databasePath = join(root, "fleet.sqlite");
      const serverEnvironment = {
        ...process.env,
        REPORTER_TOKEN: reporterToken,
        DB_PATH: databasePath,
        PORT: String(port),
        FLEET_MODE: "1",
        FLEET_DAILY_CAP: "10",
        FLEET_PER_PROJECT_CAP: "1",
        FLEET_ADOPT_TTL_MIN: "2",
      };
      let server: ChildProcess | undefined;
      let serverStderr = "";
      let bridge: MissionGraphBridge | undefined;
      const startServer = (seedProjectId?: string): ChildProcess => {
        const child = spawn(process.execPath, [join(repositoryRoot, "server/node_modules/tsx/dist/cli.mjs"), "src/http.ts"], {
          cwd: join(repositoryRoot, "server"),
          env: {
            ...serverEnvironment,
            ...(seedProjectId === undefined ? {} : { SEED_PROJECT_ID: seedProjectId }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          serverStderr += chunk.toString();
        });
        return child;
      };
      try {
        server = startServer();
        await serverWhenReady(serverUrl);
        const seedResponse = await fetch(`${serverUrl}/api/import-seed`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${reporterToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            v: 1,
            events: [
              {
                seq: 1,
                project_id: "fleet-template-source",
                ts: "2026-08-31T12:00:00.000Z",
                actor: "human",
                type: "TASK_ADDED",
                payload: {
                  node: {
                    id: "fleet-template-node",
                    title: "Fleet integration template",
                    brief: "MOCK_REPORT_LIFECYCLE MOCK_DELAY_250 Execute the seeded integration task.",
                    estimate_min: 1,
                    tags: ["fleet-integration"],
                    state: "queued",
                  },
                },
                idem_key: "fleet-template-add",
              },
            ],
          }),
        });
        if (!seedResponse.ok) {
          throw new Error(`seed import failed (${seedResponse.status}): ${await seedResponse.text()}`);
        }
        const seed = await seedResponse.json() as { project_id: string; token: string };
        await stopProcess(server);
        server = startServer(seed.project_id);
        await serverWhenReady(serverUrl);

        const clone = await cloneWhenReady(serverUrl);
        const snapshotResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(clone.project)}/snapshot`, {
          headers: { "x-mg-token": clone.token },
        });
        if (!snapshotResponse.ok) {
          throw new Error(`clone snapshot failed (${snapshotResponse.status}): ${await snapshotResponse.text()}`);
        }
        const snapshot = await snapshotResponse.json() as {
          state: { nodes: Record<string, { id: string; title: string; brief: string }> };
        };
        const node = Object.values(snapshot.state.nodes).find((candidate) => candidate.title === "Fleet integration template");
        if (!node) {
          throw new Error(
            `seeded clone did not contain the fleet integration template; titles=${JSON.stringify(Object.values(snapshot.state.nodes).map((candidate) => candidate.title))}; server=${serverStderr}`,
          );
        }
        await confirmedMutation(
          serverUrl,
          clone.project,
          clone.token,
          "DISPATCHED",
          { node_id: node.id, bypass_cap: true },
          "fleet-integration-dispatch",
        );
        const enqueueResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(clone.project)}/fleet-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-mg-token": clone.token },
          body: JSON.stringify({ node_id: node.id }),
        });
        if (!enqueueResponse.ok) {
          throw new Error(`fleet enqueue failed (${enqueueResponse.status}): ${await enqueueResponse.text()}`);
        }
        const request = await enqueueResponse.json() as { id: string };

        const repoPath = join(root, "target-repo");
        await initializeRepo(repoPath);
        const statePath = join(root, "fleet-state.json");
        const logger = new TestLogger();
        bridge = new MissionGraphBridge({
          ...config(root, repoPath),
          serverUrl,
          projectId: seed.project_id,
          visitorToken: seed.token,
          reporterCredential: reporterToken,
          statePath,
          fleetMode: true,
          fleetPollMs: 20,
          fleetHeartbeatMs: 30,
          fleetRunTtlMs: 5_000,
        }, logger, true, async (pid) => `fleet-integration-${pid}`);
        await bridge.start();

        const adoptedAt = new Set<string>();
        let requestStatus = "queued";
        for (let attempt = 0; attempt < 500 && requestStatus !== "done"; attempt += 1) {
          const response = await fetch(
            `${serverUrl}/api/p/${encodeURIComponent(clone.project)}/fleet-requests/${encodeURIComponent(request.id)}`,
            { headers: { "x-mg-token": clone.token } },
          );
          if (!response.ok) throw new Error(`fleet request poll failed (${response.status}): ${await response.text()}`);
          const body = await response.json() as { status: string; adopted_at?: string };
          requestStatus = body.status;
          if (body.adopted_at) adoptedAt.add(body.adopted_at);
          if (requestStatus !== "done") await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        expect(requestStatus).toBe("done");
        expect(adoptedAt.size).toBeGreaterThanOrEqual(2);

        const ledgerResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(clone.project)}/export`, {
          headers: { "x-mg-token": clone.token },
        });
        if (!ledgerResponse.ok) {
          throw new Error(`clone ledger failed (${ledgerResponse.status}): ${await ledgerResponse.text()}`);
        }
        const ledger = await ledgerResponse.json() as {
          events: { type: string; actor: string; payload: { node_id?: string } }[];
        };
        const lifecycle = ledger.events.filter((event) => event.payload.node_id === node.id);
        for (const type of ["NODE_STATE_CHANGED", "WORKER_LOG", "HANDOFF_FILED", "APPROVAL_CREATED"]) {
          expect(lifecycle.some((event) => event.type === type)).toBe(true);
        }
        expect(lifecycle.filter((event) => [
          "NODE_STATE_CHANGED",
          "WORKER_LOG",
          "HANDOFF_FILED",
          "APPROVAL_CREATED",
        ].includes(event.type)).every((event) => event.actor === `worker:${node.id}`)).toBe(true);

        for (let attempt = 0; attempt < 100 && bridge.getState()?.fleet_adoption !== undefined; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        expect(bridge.getState()?.fleet_adoption).toBeUndefined();
        expect(Object.keys(bridge.getState()?.workers ?? {}).some((key) => key.startsWith("fleet:"))).toBe(false);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        await bridge.stop();
        bridge = undefined;
        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          fleet_adoption?: unknown;
          workers: Record<string, unknown>;
          supervisor_pid?: number;
        };
        expect(persisted.fleet_adoption).toBeUndefined();
        expect(Object.keys(persisted.workers).some((key) => key.startsWith("fleet:"))).toBe(false);
        expect(persisted.supervisor_pid).toBeUndefined();
        await expect(readFile(`${statePath}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(logger.errorMessages).toEqual([]);
      } finally {
        await bridge?.stop();
        if (server) await stopProcess(server);
        await rm(root, { recursive: true, force: true });
      }
      expect(serverStderr).not.toContain("Error:");
    },
    30_000,
  );
});
