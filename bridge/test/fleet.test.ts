import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ActionExecutor } from "../src/actions.js";
import { CodexClient, codexChildEnvironment, workerChildEnvironment } from "../src/codex.js";
import type { BridgeConfig } from "../src/config.js";
import { FleetAdoptionLoop, type FleetClaim } from "../src/fleet.js";
import { adoptedWorkerBrief } from "../src/prompts.js";
import { StateStore } from "../src/state.js";
import { ExecutionSlot } from "../src/slot.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

interface CompletionCall {
  requestId: string;
  body: { outcome: "done" | "failed"; note?: string };
}

class FleetStub {
  readonly nextTimes: number[] = [];
  readonly heartbeatTimes: number[] = [];
  readonly completionCalls: CompletionCall[] = [];
  readonly credentialProjects: string[] = [];
  readonly credentialActors: string[] = [];
  readonly claims: (FleetClaim | undefined)[] = [];
  readonly missingProjects = new Set<string>();
  heartbeatMissingAfter: number | undefined;
  completeMissing = false;
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.route(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind fleet stub");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    if (request.method === "POST" && url.pathname === "/api/fleet/next") {
      this.requireReporter(request);
      this.nextTimes.push(Date.now());
      const claim = this.claims.shift();
      if (!claim) return this.send(response, 204);
      return this.json(response, 200, claim);
    }
    const heartbeat = url.pathname.match(/^\/api\/fleet\/([^/]+)\/heartbeat$/);
    if (request.method === "POST" && heartbeat) {
      this.requireReporter(request);
      const index = this.heartbeatTimes.length;
      this.heartbeatTimes.push(Date.now());
      if (this.heartbeatMissingAfter !== undefined && index >= this.heartbeatMissingAfter) {
        return this.json(response, 404, { error: { code: "unknown_fleet_request", message: "missing" } });
      }
      return this.json(response, 200, { ok: true });
    }
    const complete = url.pathname.match(/^\/api\/fleet\/([^/]+)\/complete$/);
    if (request.method === "POST" && complete) {
      this.requireReporter(request);
      const body = await this.body(request) as CompletionCall["body"];
      this.completionCalls.push({ requestId: decodeURIComponent(complete[1]!), body });
      if (this.completeMissing) {
        return this.json(response, 404, { error: { code: "unknown_fleet_request", message: "missing" } });
      }
      return this.json(response, 200, { ok: true });
    }
    const credential = url.pathname.match(/^\/api\/p\/([^/]+)\/reporter-credentials$/);
    if (request.method === "POST" && credential) {
      const project = decodeURIComponent(credential[1]!);
      this.credentialProjects.push(project);
      const body = await this.body(request) as { actor: string };
      this.credentialActors.push(body.actor);
      if (this.missingProjects.has(project)) {
        return this.json(response, 404, { error: { code: "unknown_project", message: "missing" } });
      }
      return this.json(response, 200, {
        token: `credential-${project}`,
        actor: body.actor,
        expires: "2099-08-30T10:15:00.000Z",
      });
    }
    if (request.method === "POST" && /^\/api\/p\/[^/]+\/report$/.test(url.pathname)) {
      return this.json(response, 200, { seq: 1 });
    }
    this.json(response, 404, { error: { code: "not_found", message: "missing" } });
  }

  private requireReporter(request: IncomingMessage): void {
    if (request.headers["x-mg-reporter"] !== "reporter-token") {
      throw new Error("fleet request omitted the supervisor reporter credential");
    }
  }

  private async body(request: IncomingMessage): Promise<unknown> {
    let value = "";
    for await (const chunk of request) value += chunk.toString();
    return JSON.parse(value);
  }

  private send(response: ServerResponse, status: number): void {
    response.writeHead(status).end();
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  }
}

interface Harness {
  root: string;
  config: BridgeConfig;
  state: StateStore;
  actions: ActionExecutor;
  codex: CodexClient;
  loop: FleetAdoptionLoop;
  slot: ExecutionSlot;
  logger: TestLogger;
  start(): void;
  stop(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function claim(brief = "Implement the adopted task."): FleetClaim {
  return {
    request_id: "request-1",
    project_id: "adopted-project",
    node_id: "adopted-node",
    node: { title: "Adopted title", brief, estimate: 2 },
    visitor_token: "adopted-visitor-token",
  };
}

async function createHarness(
  stub: FleetStub,
  overrides: Partial<BridgeConfig> = {},
  persistBeforeRestart?: (state: StateStore) => Promise<void>,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "missiongraph-fleet-"));
  const bridgeConfig: BridgeConfig = {
    ...config(root),
    serverUrl: stub.url,
    fleetMode: true,
    fleetPollMs: 40,
    fleetRunTtlMs: 1_000,
    fleetHeartbeatMs: 30,
    ...overrides,
  };
  await initializeRepo(bridgeConfig.targetRepoPath);
  const processStartTime = async (pid: number): Promise<string | undefined> => {
    if (pid === process.pid) return "fleet-test-bridge";
    try {
      process.kill(pid, 0);
      return `fleet-test-child-${pid}`;
    } catch {
      return undefined;
    }
  };
  let state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, processStartTime);
  if (persistBeforeRestart) {
    await persistBeforeRestart(state);
    await state.close();
    state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, processStartTime);
  }
  const logger = new TestLogger();
  const slot = new ExecutionSlot();
  const codex = new CodexClient(bridgeConfig, logger, true, processStartTime);
  const actions = new ActionExecutor(bridgeConfig, state, codex, logger, true, processStartTime, slot);
  await actions.initialize();
  const loop = new FleetAdoptionLoop(bridgeConfig, state, actions, slot, logger, processStartTime);
  let started = false;
  const harness: Harness = {
    root,
    config: bridgeConfig,
    state,
    actions,
    codex,
    loop,
    slot,
    logger,
    start: () => {
      started = true;
      loop.start();
    },
    stop: async () => {
      if (started) await loop.stop();
      await codex.stop();
      await actions.terminateAll();
      await actions.stop();
      await state.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  cleanups.push(() => harness.stop());
  return harness;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fleet test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startedStub(): Promise<FleetStub> {
  const stub = new FleetStub();
  await stub.start();
  cleanups.push(() => stub.stop());
  return stub;
}

describe("FleetAdoptionLoop", () => {
  it("leaves flagship execution uncoordinated when fleet mode is off", () => {
    const slot = new ExecutionSlot(false);
    expect(slot.tryAcquire("flagship supervisor")).toBeDefined();
    expect(slot.tryAcquire("flagship worker")).toBeDefined();
    expect(slot.owner).toBeUndefined();
  });

  it("does not poll when fleet mode is disabled", async () => {
    const stub = await startedStub();
    stub.claims.push(claim());
    const harness = await createHarness(stub, { fleetMode: false });
    harness.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.nextTimes).toEqual([]);
    expect(harness.state.state.fleet_adoption).toBeUndefined();
  });

  it("claims, mints against the adopted project, runs one mock worker, heartbeats, and completes done", async () => {
    const stub = await startedStub();
    stub.claims.push(claim());
    const harness = await createHarness(stub);
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");

    expect(harness.state.state.fleet_adoption).toMatchObject({
      request_id: "request-1",
      project_id: "adopted-project",
      node_id: "adopted-node",
      outcome: "done",
    });
    expect(stub.credentialProjects).toEqual(["adopted-project"]);
    expect(stub.credentialActors).toEqual(["worker:adopted-node"]);
    expect(stub.heartbeatTimes.length).toBeGreaterThanOrEqual(1);
    expect(stub.completionCalls).toEqual([{ requestId: "request-1", body: { outcome: "done" } }]);
    expect(harness.state.state.workers["fleet:request-1"]).toMatchObject({
      status: "idle",
      node_id: "adopted-node",
      project_id: "adopted-project",
      fleet_request_id: "request-1",
      thread_id: "mock-worker-adopted-node",
    });
  });

  it("places the server title and brief verbatim into the existing worker brief", () => {
    const prompt = adoptedWorkerBrief("node", "Title from server", "Brief from server\nwith details", "/repo");
    expect(prompt).toContain("Task brief: Title from server\n\nBrief from server\nwith details\nTarget repository: /repo");
  });

  it("does not poll while a flagship execution owns the global slot", async () => {
    const stub = await startedStub();
    stub.claims.push(claim());
    const harness = await createHarness(stub);
    const flagship = harness.slot.tryAcquire("flagship action in flight");
    expect(flagship).toBeDefined();
    harness.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(stub.nextTimes).toEqual([]);

    flagship!.release();
    await waitFor(() => stub.nextTimes.length === 1);
  });

  it("terminates a worker at FLEET_RUN_TTL_MIN and completes failed", async () => {
    const stub = await startedStub();
    stub.claims.push(claim("MOCK_HANG"));
    const harness = await createHarness(stub, { fleetRunTtlMs: 90 });
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(stub.completionCalls[0]?.body).toMatchObject({
      outcome: "failed",
      note: expect.stringContaining("FLEET_RUN_TTL_MIN"),
    });
    expect(harness.state.state.workers["fleet:request-1"]?.status).toBe("idle");
  });

  it("heartbeats repeatedly within the configured cadence while a worker runs", async () => {
    const stub = await startedStub();
    stub.claims.push(claim("MOCK_DELAY_180"));
    const harness = await createHarness(stub, { fleetHeartbeatMs: 35 });
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(stub.heartbeatTimes.length).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < stub.heartbeatTimes.length; index += 1) {
      expect(stub.heartbeatTimes[index]! - stub.heartbeatTimes[index - 1]!).toBeLessThan(100);
    }
  });

  it("fails a persisted adoption on restart when no worker process survived", async () => {
    const stub = await startedStub();
    const harness = await createHarness(stub, { fleetPollMs: 500 }, async (state) => {
      state.state.fleet_adoption = {
        ...claim(),
        worker_key: "fleet:request-1",
        status: "adopted",
        adopted_at: new Date().toISOString(),
      };
      await state.save();
    });
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(stub.nextTimes).toEqual([]);
    expect(stub.completionCalls[0]?.body).toMatchObject({
      outcome: "failed",
      note: expect.stringContaining("restart found no live process"),
    });
  });

  it("resumes heartbeats for a persisted live adoption and fails honestly when its process disappears", async () => {
    const stub = await startedStub();
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    });
    const harness = await createHarness(stub, {}, async (state) => {
      const adopted = claim();
      state.state.fleet_adoption = {
        ...adopted,
        worker_key: "fleet:request-1",
        status: "running",
        adopted_at: new Date(Date.now() - 100).toISOString(),
        started_at: new Date(Date.now() - 100).toISOString(),
      };
      state.state.workers["fleet:request-1"] = {
        status: "live",
        thread_id: "recovered-thread",
        worktree: join(dirname(state.path), "recovered-worktree"),
        branch: "work/recovered",
        reporter_credential: "credential-adopted-project",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        node_id: adopted.node_id,
        project_id: adopted.project_id,
        fleet_request_id: adopted.request_id,
        pid: child.pid!,
        process_start_time: `fleet-test-child-${child.pid}`,
      };
      await state.save();
    });
    harness.start();

    await waitFor(() => stub.heartbeatTimes.length >= 2);
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(stub.completionCalls[0]?.body).toMatchObject({
      outcome: "failed",
      note: expect.stringContaining("no longer running"),
    });
  });

  it("does not rerun a completed persisted request if the server returns it again", async () => {
    const stub = await startedStub();
    stub.claims.push(claim());
    const harness = await createHarness(stub, {}, async (state) => {
      state.state.fleet_adoption = {
        ...claim(),
        worker_key: "fleet:request-1",
        status: "completed",
        adopted_at: new Date(Date.now() - 1_000).toISOString(),
        outcome: "done",
        finished_at: new Date().toISOString(),
      };
      await state.save();
    });
    harness.start();

    await waitFor(() => stub.completionCalls.length === 1);
    expect(stub.credentialProjects).toEqual([]);
    expect(harness.state.state.workers).toEqual({});
    expect(stub.completionCalls[0]?.body.outcome).toBe("done");
  });

  it("backs off after 204 empty responses instead of busy-polling", async () => {
    const stub = await startedStub();
    const harness = await createHarness(stub, { fleetPollMs: 45 });
    harness.start();
    await waitFor(() => stub.nextTimes.length >= 3);

    expect(stub.nextTimes.length).toBeLessThanOrEqual(4);
    for (let index = 1; index < stub.nextTimes.length; index += 1) {
      expect(stub.nextTimes[index]! - stub.nextTimes[index - 1]!).toBeGreaterThanOrEqual(35);
    }
  });

  it("completes failed without spawning when the adopted project becomes stale", async () => {
    const stub = await startedStub();
    stub.claims.push(claim());
    stub.missingProjects.add("adopted-project");
    const harness = await createHarness(stub);
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(harness.state.state.workers["fleet:request-1"]).toBeUndefined();
    expect(stub.completionCalls[0]?.body).toMatchObject({
      outcome: "failed",
      note: expect.stringContaining("reporter credential POST failed (404)"),
    });
  });

  it("completes failed when the mock worker exits unsuccessfully", async () => {
    const stub = await startedStub();
    stub.claims.push(claim("MOCK_FAIL"));
    const harness = await createHarness(stub);
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(stub.completionCalls[0]?.body).toMatchObject({
      outcome: "failed",
      note: expect.stringContaining("exited unsuccessfully"),
    });
  });

  it("kills the worker and abandons cleanly when a heartbeat says the claim is stale", async () => {
    const stub = await startedStub();
    stub.claims.push(claim("MOCK_HANG"));
    stub.heartbeatMissingAfter = 0;
    const harness = await createHarness(stub);
    harness.start();

    await waitFor(() => harness.state.state.fleet_adoption?.status === "completed");
    expect(stub.completionCalls[0]?.body).toMatchObject({
      outcome: "failed",
      note: expect.stringContaining("became stale"),
    });
    expect(harness.state.state.workers["fleet:request-1"]?.status).toBe("idle");
  });

  it("uses exactly the flagship OPENAI/CODEX environment allowlist for adopted workers", () => {
    const flagship = config("/tmp/flagship");
    const adopted = { ...flagship, projectId: "adopted-project" };
    const source = {
      PATH: "/usr/bin",
      CODEX_HOME: "/codex",
      CODEX_API_KEY: "codex-key",
      OPENAI_API_KEY: "openai-key",
      OPENAI_ORG_ID: "org",
      REPORTER_TOKEN: "master-secret",
      MG_REPORTER_CREDENTIAL: "master-credential",
      MG_VISITOR_TOKEN: "visitor-secret",
    };
    const flagshipEnvironment = codexChildEnvironment(
      workerChildEnvironment(flagship, "node", "/tmp/flagship.conf"),
      source,
    );
    const adoptedEnvironment = codexChildEnvironment(
      workerChildEnvironment(adopted, "node", "/tmp/adopted.conf"),
      source,
    );

    expect(Object.keys(adoptedEnvironment).filter((name) => /^(OPENAI|CODEX)_/.test(name)).sort()).toEqual(
      Object.keys(flagshipEnvironment).filter((name) => /^(OPENAI|CODEX)_/.test(name)).sort(),
    );
    expect(adoptedEnvironment.REPORTER_TOKEN).toBeUndefined();
    expect(adoptedEnvironment.MG_REPORTER_CREDENTIAL).toBeUndefined();
    expect(adoptedEnvironment.MG_VISITOR_TOKEN).toBeUndefined();
  });
});
