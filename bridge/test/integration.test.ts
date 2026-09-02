import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MissionGraphBridge } from "../src/bridge.js";
import { ReporterClient, reporterPayload } from "../src/reporter.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function committingMockCodex(root: string): Promise<string> {
  const source = await readFile(join(repositoryRoot, "bridge/mock-codex.mjs"), "utf8");
  const withImports = source
    .replace('import { spawn } from "node:child_process";', 'import { execFileSync, spawn } from "node:child_process";')
    .replace('import { createHash, randomUUID } from "node:crypto";', 'import { createHash, randomUUID } from "node:crypto";\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";');
  const withCommit = withImports.replace(
    '  if (reportLifecycle) {\n    await report("WORKER_LOG", { node_id: nodeId, lines: ["Mock fleet worker finished."] });',
    '  if (reportLifecycle) {\n    const workerDirectory = args[args.indexOf("-C") + 1];\n    if (!workerDirectory) throw new Error("mock worker checkout is missing");\n    const artifact = `.missiongraph-mock-${createHash("sha1").update(nodeId).digest("hex").slice(0, 8)}.txt`;\n    writeFileSync(join(workerDirectory, artifact), `Mock completion for ${nodeId}.\\n`);\n    execFileSync("git", ["-C", workerDirectory, "add", artifact]);\n    execFileSync("git", ["-C", workerDirectory, "commit", "-m", `test: complete ${nodeId}`]);\n    const mockCommit = execFileSync("git", ["-C", workerDirectory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();\n    await report("WORKER_LOG", { node_id: nodeId, lines: ["Mock fleet worker finished."] });',
  ).replace("        commits: [],", "        commits: [mockCommit],");
  if (withCommit === source || !withCommit.includes("commits: [mockCommit]")) {
    throw new Error("test mock patch did not match bridge/mock-codex.mjs");
  }
  const path = join(root, "committing-mock-codex.mjs");
  await writeFile(path, withCommit, { mode: 0o700 });
  return path;
}

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
    "pauses a running mock worker when SIGTERM shuts down the bridge",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "missiongraph-sigterm-integration-"));
      const port = await freePort();
      const reporterToken = "sigterm-integration-reporter-token";
      const serverUrl = `http://127.0.0.1:${port}`;
      const server = spawn("pnpm", ["--dir", join(repositoryRoot, "server"), "exec", "tsx", "src/http.ts"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          REPORTER_TOKEN: reporterToken,
          DB_PATH: join(root, "sigterm.sqlite"),
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let serverStderr = "";
      server.stderr?.on("data", (chunk: Buffer) => {
        serverStderr += chunk.toString();
      });
      let bridgeProcess: ChildProcess | undefined;
      let bridgeStderr = "";
      try {
        const clone = await cloneWhenReady(serverUrl);
        const repoPath = join(root, "target-repo");
        const statePath = join(root, "bridge-state.json");
        await initializeRepo(repoPath);
        await mutation(
          serverUrl,
          clone.project,
          clone.token,
          "TASK_ADDED",
          {
            node: {
              id: "sigterm-node",
              title: "SIGTERM node",
              brief: "Exercise graceful worker detachment.",
              estimate_min: 1,
              tags: ["sigterm"],
              state: "queued",
            },
          },
          "sigterm-add",
        );
        await confirmedMutation(
          serverUrl,
          clone.project,
          clone.token,
          "DISPATCHED",
          {
            node_id: "sigterm-node",
            brief_override: "MOCK_REPORT_LIFECYCLE MOCK_HANG",
            bypass_cap: true,
          },
          "sigterm-dispatch",
        );

        bridgeProcess = spawn(
          process.execPath,
          [join(repositoryRoot, "server/node_modules/tsx/dist/cli.mjs"), "test/sigterm-bridge.ts"],
          {
            cwd: join(repositoryRoot, "bridge"),
            env: {
              ...process.env,
              MG_SERVER_URL: serverUrl,
              MG_PROJECT_ID: clone.project,
              MG_VISITOR_TOKEN: clone.token,
              MG_REPORTER_CREDENTIAL: reporterToken,
              MG_TARGET_REPO: repoPath,
              MG_BRIDGE_STATE: statePath,
              FLEET_MODE: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        bridgeProcess.stderr?.on("data", (chunk: Buffer) => {
          bridgeStderr += chunk.toString();
        });

        let workerPid: number | undefined;
        let nodeState: string | undefined;
        for (let attempt = 0; attempt < 200 && (!workerPid || nodeState !== "running"); attempt += 1) {
          const snapshotResponse = await fetch(
            `${serverUrl}/api/p/${encodeURIComponent(clone.project)}/snapshot`,
            { headers: { "x-mg-token": clone.token } },
          );
          if (snapshotResponse.ok) {
            const snapshot = await snapshotResponse.json() as {
              state: { nodes: Record<string, { state: string }> };
            };
            nodeState = snapshot.state.nodes["sigterm-node"]?.state;
          }
          try {
            const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
              workers: Record<string, { pid?: number }>;
            };
            workerPid = persisted.workers["sigterm-node"]?.pid;
          } catch {
            workerPid = undefined;
          }
          if (!workerPid || nodeState !== "running") {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          }
        }
        expect(nodeState, bridgeStderr).toBe("running");
        expect(workerPid, bridgeStderr).toEqual(expect.any(Number));
        expect(() => process.kill(workerPid!, 0)).not.toThrow();

        await stopProcess(bridgeProcess);
        bridgeProcess = undefined;

        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          workers: Record<string, { status: string; pid?: number }>;
        };
        expect(persisted.workers["sigterm-node"]).toMatchObject({ status: "idle" });
        expect(persisted.workers["sigterm-node"]).not.toHaveProperty("pid");
        expect(() => process.kill(workerPid!, 0)).toThrow();

        const snapshotResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(clone.project)}/snapshot`, {
          headers: { "x-mg-token": clone.token },
        });
        const snapshot = await snapshotResponse.json() as {
          state: { nodes: Record<string, { state: string }> };
        };
        expect(snapshot.state.nodes["sigterm-node"]?.state).toBe("paused");
        const ledgerResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(clone.project)}/export`, {
          headers: { "x-mg-token": clone.token },
        });
        const ledger = await ledgerResponse.json() as {
          events: { actor: string; type: string; payload: Record<string, unknown> }[];
        };
        expect(ledger.events.filter((event) =>
          event.actor === "worker:sigterm-node" &&
          event.type === "NODE_STATE_CHANGED" &&
          event.payload.to === "paused"
        )).toEqual([
          expect.objectContaining({
            payload: {
              node_id: "sigterm-node",
              from: "running",
              to: "paused",
              detail: "worker detached during bridge shutdown",
            },
          }),
        ]);
        expect(bridgeStderr).not.toContain("Error:");
      } finally {
        if (bridgeProcess) await stopProcess(bridgeProcess);
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
              {
                seq: 2,
                project_id: "fleet-template-source",
                ts: "2026-08-31T12:00:01.000Z",
                actor: "human",
                type: "TASK_ADDED",
                payload: {
                  node: {
                    id: "fleet-partial-protocol-node",
                    title: "Fleet partial protocol template",
                    brief: "MOCK_REPORT_LIFECYCLE MOCK_PARTIAL_PROTOCOL Execute the partial protocol task.",
                    estimate_min: 1,
                    tags: ["fleet-integration"],
                    state: "queued",
                  },
                },
                idem_key: "fleet-partial-protocol-add",
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
        const partialClone = await cloneWhenReady(serverUrl);
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
        const partialSnapshotResponse = await fetch(
          `${serverUrl}/api/p/${encodeURIComponent(partialClone.project)}/snapshot`,
          { headers: { "x-mg-token": partialClone.token } },
        );
        if (!partialSnapshotResponse.ok) {
          throw new Error(
            `partial clone snapshot failed (${partialSnapshotResponse.status}): ${await partialSnapshotResponse.text()}`,
          );
        }
        const partialSnapshot = await partialSnapshotResponse.json() as {
          state: { nodes: Record<string, { id: string; title: string; brief: string }> };
        };
        const partialNode = Object.values(partialSnapshot.state.nodes)
          .find((candidate) => candidate.title === "Fleet partial protocol template");
        if (!partialNode) throw new Error("seeded clone did not contain the partial protocol template");
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
        await confirmedMutation(
          serverUrl,
          partialClone.project,
          partialClone.token,
          "DISPATCHED",
          { node_id: partialNode.id, bypass_cap: true },
          "fleet-partial-protocol-dispatch",
        );
        const partialEnqueueResponse = await fetch(
          `${serverUrl}/api/p/${encodeURIComponent(partialClone.project)}/fleet-requests`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-mg-token": partialClone.token },
            body: JSON.stringify({ node_id: partialNode.id }),
          },
        );
        if (!partialEnqueueResponse.ok) {
          throw new Error(
            `partial fleet enqueue failed (${partialEnqueueResponse.status}): ${await partialEnqueueResponse.text()}`,
          );
        }
        const partialRequest = await partialEnqueueResponse.json() as { id: string };

        const repoPath = join(root, "target-repo");
        await initializeRepo(repoPath);
        const mockCodexPath = await committingMockCodex(root);
        const statePath = join(root, "fleet-state.json");
        const logger = new TestLogger();
        bridge = new MissionGraphBridge({
          ...config(root, repoPath),
          serverUrl,
          projectId: seed.project_id,
          visitorToken: seed.token,
          reporterCredential: reporterToken,
          codexBinaryPath: mockCodexPath,
          statePath,
          fleetMode: true,
          fleetPollMs: 20,
          fleetHeartbeatMs: 30,
          fleetRunTtlMs: 5_000,
        }, logger, false, async (pid) => `fleet-integration-${pid}`);
        await bridge.start();

        const adoptedAt = new Set<string>();
        let requestStatus = "queued";
        let requestNote: string | null = null;
        for (
          let attempt = 0;
          attempt < 500 && !["done", "failed"].includes(requestStatus);
          attempt += 1
        ) {
          const response = await fetch(
            `${serverUrl}/api/p/${encodeURIComponent(clone.project)}/fleet-requests/${encodeURIComponent(request.id)}`,
            { headers: { "x-mg-token": clone.token } },
          );
          if (!response.ok) throw new Error(`fleet request poll failed (${response.status}): ${await response.text()}`);
          const body = await response.json() as { status: string; adopted_at?: string; note: string | null };
          requestStatus = body.status;
          requestNote = body.note;
          if (body.adopted_at) adoptedAt.add(body.adopted_at);
          if (!["done", "failed"].includes(requestStatus)) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        }
        expect(requestStatus, requestNote ?? undefined).toBe("done");
        expect(adoptedAt.size).toBeGreaterThanOrEqual(2);

        let partialRequestStatus = "queued";
        let partialRequestNote: string | null = null;
        for (
          let attempt = 0;
          attempt < 500 && !["done", "failed"].includes(partialRequestStatus);
          attempt += 1
        ) {
          const response = await fetch(
            `${serverUrl}/api/p/${encodeURIComponent(partialClone.project)}/fleet-requests/${encodeURIComponent(partialRequest.id)}`,
            { headers: { "x-mg-token": partialClone.token } },
          );
          if (!response.ok) {
            throw new Error(`partial fleet request poll failed (${response.status}): ${await response.text()}`);
          }
          const body = await response.json() as { status: string; note: string | null };
          partialRequestStatus = body.status;
          partialRequestNote = body.note;
          if (!["done", "failed"].includes(partialRequestStatus)) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        }
        expect(partialRequestStatus).toBe("failed");
        expect(partialRequestNote).toContain("APPROVAL_CREATED");
        const partialLedgerResponse = await fetch(
          `${serverUrl}/api/p/${encodeURIComponent(partialClone.project)}/export`,
          { headers: { "x-mg-token": partialClone.token } },
        );
        if (!partialLedgerResponse.ok) {
          throw new Error(
            `partial clone ledger failed (${partialLedgerResponse.status}): ${await partialLedgerResponse.text()}`,
          );
        }
        const partialLedger = await partialLedgerResponse.json() as {
          events: { type: string; actor: string; payload: { node_id?: string } }[];
        };
        const partialLifecycle = partialLedger.events.filter((event) => event.payload.node_id === partialNode.id);
        expect(partialLifecycle.some((event) => event.type === "NODE_STATE_CHANGED")).toBe(true);
        expect(partialLifecycle.some((event) => event.type === "HANDOFF_FILED")).toBe(true);
        expect(partialLifecycle.some((event) => event.type === "APPROVAL_CREATED")).toBe(false);

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

  it(
    "deduplicates a replayed lost-worker report through the real reporter ingress",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "missiongraph-lost-worker-replay-"));
      const port = await freePort();
      const reporterToken = "lost-worker-replay-reporter-token";
      const serverUrl = `http://127.0.0.1:${port}`;
      const server = spawn(process.execPath, [join(repositoryRoot, "server/node_modules/tsx/dist/cli.mjs"), "src/http.ts"], {
        cwd: join(repositoryRoot, "server"),
        env: {
          ...process.env,
          REPORTER_TOKEN: reporterToken,
          DB_PATH: join(root, "lost-worker-replay.sqlite"),
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let serverStderr = "";
      server.stderr?.on("data", (chunk: Buffer) => {
        serverStderr += chunk.toString();
      });
      try {
        await serverWhenReady(serverUrl);
        const seedResponse = await fetch(`${serverUrl}/api/import-seed`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${reporterToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            v: 1,
            events: [{
              seq: 1,
              project_id: "lost-worker-replay-source",
              ts: "2026-09-02T04:30:00.000Z",
              actor: "human",
              type: "TASK_ADDED",
              payload: {
                node: {
                  id: "replay-node",
                  title: "Replay node",
                  brief: "Verify lost-worker report replay.",
                  estimate_min: 1,
                  tags: ["integration"],
                  state: "queued",
                },
              },
              idem_key: "d322bc3b-74a6-43c4-ac55-ac1d19e1001a",
            }],
          }),
        });
        if (!seedResponse.ok) {
          throw new Error(`seed import failed (${seedResponse.status}): ${await seedResponse.text()}`);
        }
        const seed = await seedResponse.json() as { project_id: string; token: string };
        const projectConfig = {
          ...config(root),
          serverUrl,
          projectId: seed.project_id,
          visitorToken: seed.token,
          reporterCredential: reporterToken,
        };
        const actor = "worker:replay-node" as const;
        const credential = await new ReporterClient(projectConfig).issue(actor);
        const reporter = new ReporterClient({ ...projectConfig, reporterCredential: credential.token });
        await reporter.post(reporterPayload(actor, "NODE_STATE_CHANGED", {
          node_id: "replay-node",
          from: "queued",
          to: "running",
        }, "98e5caf5-8135-4d05-b083-a217e9843246"));
        const replayedReport = reporterPayload(actor, "NODE_STATE_CHANGED", {
          node_id: "replay-node",
          from: "running",
          to: "failed",
          detail: "Fleet worker was lost before it filed its reports.",
        }, "7e893545-18ea-5b37-85f7-26f5956e4c31");

        const firstSeq = await reporter.post(replayedReport);
        const replaySeq = await new ReporterClient({
          ...projectConfig,
          reporterCredential: credential.token,
        }).post(replayedReport);

        expect(replaySeq).toBe(firstSeq);
        const ledgerResponse = await fetch(`${serverUrl}/api/p/${encodeURIComponent(seed.project_id)}/export`, {
          headers: { "x-mg-token": seed.token },
        });
        if (!ledgerResponse.ok) {
          throw new Error(`ledger export failed (${ledgerResponse.status}): ${await ledgerResponse.text()}`);
        }
        const ledger = await ledgerResponse.json() as {
          events: { idem_key: string; type: string; payload: Record<string, unknown> }[];
        };
        expect(ledger.events.filter((event) => event.idem_key === replayedReport.idem_key)).toEqual([
          expect.objectContaining({
            type: "NODE_STATE_CHANGED",
            payload: expect.objectContaining({ node_id: "replay-node", to: "failed" }),
          }),
        ]);
      } finally {
        await stopProcess(server);
        await rm(root, { recursive: true, force: true });
      }
      expect(serverStderr).not.toContain("Error:");
    },
    10_000,
  );
});
