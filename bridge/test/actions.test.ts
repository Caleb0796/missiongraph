import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ActionExecutor } from "../src/actions.js";
import type { RunningCodex } from "../src/codex.js";
import { ExecutionSlot } from "../src/slot.js";
import { StateStore } from "../src/state.js";
import type { SupervisorDecision } from "../src/types.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

let nextPid = 10_000;
const lockProcessStartTime = async (pid: number): Promise<string | undefined> =>
  pid === process.pid ? "test-bridge-start" : undefined;

function running(
  threadId: string,
  completed: RunningCodex["completed"] = Promise.resolve({ stdout: "", stderr: "", threadId }),
  terminate: () => Promise<void> = async () => undefined,
): RunningCodex {
  const pid = nextPid += 1;
  void completed.catch(() => undefined);
  return {
    pid,
    identity: Promise.resolve({ pid, starttime: `start-${pid}` }),
    threadId: Promise.resolve(threadId),
    completed,
    begin: () => undefined,
    terminate,
  };
}

describe("ActionExecutor", () => {
  it("persists process identity, renews before resume, and makes active spawns idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-actions-"));
    const issued: string[] = [];
    const reports: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/reporter-credentials")) {
        const body = JSON.parse(String(init?.body)) as { actor: string };
        const token = `worker-token-${issued.length + 1}`;
        issued.push(token);
        return Response.json({ token, actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
      }
      reports.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ seq: 1 });
    }));
    let completeInitial!: () => void;
    const initialCompleted = new Promise<{ stdout: string; stderr: string }>((resolvePromise) => {
      completeInitial = () => resolvePromise({ stdout: "", stderr: "" });
    });
    let resolveInitialThread!: (threadId: string) => void;
    const initialThread = new Promise<string>((resolvePromise) => {
      resolveInitialThread = resolvePromise;
    });
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      const resumed: string[] = [];
      const codex = {
        startWorker: () => {
          expect(state?.state.workers["node-a"]?.status).toBe("spawning");
          expect(JSON.parse(readFileSync(bridgeConfig.statePath, "utf8"))).toMatchObject({
            workers: { "node-a": { status: "spawning" } },
          });
          const worker = running("worker-node-a", initialCompleted, async () => completeInitial());
          return {
            ...worker,
            threadId: initialThread,
            begin: () => {
              expect(JSON.parse(readFileSync(bridgeConfig.statePath, "utf8"))).toMatchObject({
                workers: {
                  "node-a": {
                    status: "spawning",
                    pid: worker.pid,
                    process_start_time: `start-${worker.pid}`,
                  },
                },
              });
            },
          };
        },
        resumeWorker: (_nodeId: string, threadId: string, message: string) => {
          expect(threadId).toBe("worker-node-a");
          resumed.push(message);
          return running(threadId);
        },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());

      const spawn = executor.execute({ actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A." }] });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!existsSync(bridgeConfig.statePath)) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          continue;
        }
        const persisted = JSON.parse(readFileSync(bridgeConfig.statePath, "utf8")) as { workers?: Record<string, { process_start_time?: string }> };
        if (persisted.workers?.["node-a"]?.process_start_time) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect(JSON.parse(readFileSync(bridgeConfig.statePath, "utf8"))).toMatchObject({
        workers: { "node-a": { status: "spawning", pid: expect.any(Number), process_start_time: expect.stringMatching(/^start-/) } },
      });
      resolveInitialThread("worker-node-a");
      await spawn;
      expect(state.state.workers["node-a"]).toMatchObject({
        status: "live",
        thread_id: "worker-node-a",
        pid: expect.any(Number),
        process_start_time: expect.stringMatching(/^start-/),
        reporter_credential: "worker-token-1",
      });
      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A twice." }] });
      completeInitial();
      for (let attempt = 0; attempt < 50 && state.state.workers["node-a"]?.status !== "idle"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect(state.state.workers["node-a"]?.status).toBe("idle");
      state.state.workers["node-a"]!.reporter_expires = new Date(Date.now() + 4 * 60_000).toISOString();
      await executor.execute({
        actions: [
          { act: "rebrief_worker", node_id: "node-a", message: "Use the new API." },
          { act: "pause_worker", node_id: "node-a" },
          { act: "resume_worker", node_id: "node-a" },
          { act: "kill_worker", node_id: "node-a" },
          { act: "note", text: "Supervisor recorded a bridge decision." },
        ],
      });

      expect(issued).toEqual(["worker-token-1", "worker-token-2", "worker-token-3", "worker-token-4"]);
      expect(state.state.workers["node-a"]).toMatchObject({ status: "idle", thread_id: "worker-node-a" });
      expect(state.state.workers["node-a"]?.pid).toBeUndefined();
      expect(resumed).toHaveLength(3);
      expect(reports.map((report) => report.body)).toEqual([
        expect.objectContaining({ type: "JOURNAL_NOTE", payload: { text: expect.stringContaining("idempotent no-op") } }),
        expect.objectContaining({ type: "JOURNAL_NOTE", payload: { text: "Supervisor recorded a bridge decision." } }),
      ]);
      expect(state.state.pending_actions).toEqual([]);
    } finally {
      completeInitial();
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects controls for a live worker with journaled notes instead of launching resumes", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-live-control-"));
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/reporter-credentials")) {
        const body = JSON.parse(String(init?.body)) as { actor: string };
        return Response.json({ token: "renewed-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
      }
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ seq: reports.length });
    }));
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      state.state.workers.a = {
        status: "live",
        thread_id: "worker-thread-a",
        worktree: join(root, "worker-a"),
        branch: "work/a",
        pid: 20_001,
        process_start_time: "worker-start",
      };
      await state.save();
      let resumes = 0;
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => {
          resumes += 1;
          return running("worker-thread-a");
        },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.execute({ actions: [
        { act: "rebrief_worker", node_id: "a", message: "New guidance." },
        { act: "resume_worker", node_id: "a" },
      ] });

      expect(resumes).toBe(0);
      expect(reports).toHaveLength(2);
      expect(reports).toEqual([
        expect.objectContaining({ payload: { text: expect.stringContaining("rebrief_worker for node a was rejected") } }),
        expect.objectContaining({ payload: { text: expect.stringContaining("resume_worker for node a was rejected") } }),
      ]);
      expect(state.state.pending_actions).toEqual([]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebriefs an idle worker by resuming its persisted thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-idle-resume-"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ seq: 1 })));
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      state.state.workers.a = {
        status: "idle",
        thread_id: "worker-thread-a",
        worktree: join(root, "worker-a"),
        branch: "work/a",
        reporter_credential: "worker-token",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: join(root, "worker-a.reporter.conf"),
      };
      await state.save();
      const resumed: { threadId: string; message: string }[] = [];
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: (_nodeId: string, threadId: string, message: string) => {
          resumed.push({ threadId, message });
          return running(threadId);
        },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.execute({ actions: [{ act: "rebrief_worker", node_id: "a", message: "Retry with guidance." }] });

      expect(resumed).toEqual([{ threadId: "worker-thread-a", message: "Retry with guidance." }]);
      expect(state.state.workers.a).toMatchObject({ status: "idle", thread_id: "worker-thread-a" });
      expect(state.state.pending_actions).toEqual([]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays a durable pending action after a simulated crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-ledger-replay-"));
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/reporter-credentials")) {
        const body = JSON.parse(String(init?.body)) as { actor: string };
        return Response.json({ token: "renewed-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
      }
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ seq: 1 });
    }));
    let reopened: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      const beforeCrash = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => { throw new Error("not used"); },
      };
      const beforeCrashExecutor = new ActionExecutor(bridgeConfig, beforeCrash, codex, new TestLogger());
      const decision: SupervisorDecision = { actions: [{ act: "note", text: "Recovered action." }] };
      await beforeCrashExecutor.record(decision, "envelope seq 41-42");
      await beforeCrashExecutor.record(decision, "envelope seq 41-42");
      expect(beforeCrash.state.pending_actions).toHaveLength(1);
      await beforeCrash.close();

      reopened = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      executor = new ActionExecutor(bridgeConfig, reopened, codex, new TestLogger());
      await executor.initialize();

      expect(reports).toEqual([
        expect.objectContaining({ idem_key: expect.stringMatching(/^[a-f0-9]{64}$/), payload: { text: "Recovered action." } }),
      ]);
      expect(reopened.state.pending_actions).toEqual([]);
    } finally {
      await executor?.stop();
      await reopened?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a mechanical failure three times before journaling the action payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-action-failure-"));
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/reporter-credentials")) {
        const body = JSON.parse(String(init?.body)) as { actor: string };
        return Response.json({ token: "renewed-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
      }
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ seq: 1 });
    }));
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    let resumes = 0;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      state.state.workers.a = {
        status: "idle",
        thread_id: "worker-a",
        worktree: join(root, "worker-a"),
        branch: "work/a",
        reporter_credential: "worker-token",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: join(root, "worker-a.reporter.conf"),
      };
      await state.save();
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => {
          resumes += 1;
          return running("worker-a", Promise.reject(new Error("resume crashed")));
        },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.execute(
        { actions: [{ act: "rebrief_worker", node_id: "a", message: "Continue." }] },
        "envelope seq 9-9",
      );
      for (let attempt = 0; attempt < 100 && state.state.pending_actions.length > 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }

      expect(resumes).toBe(3);
      expect(state.state.pending_actions).toEqual([]);
      expect(reports).toEqual([
        expect.objectContaining({
          type: "JOURNAL_NOTE",
          payload: { text: expect.stringMatching(/permanently failed.*envelope seq 9-9.*Action payload:.*rebrief_worker/) },
        }),
      ]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dead-letters an action when permanent-failure journaling fails and continues draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-dead-letter-"));
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/reporter-credentials")) {
        return Response.json({
          token: "renewed-token",
          actor: body.actor,
          expires: "2099-08-30T10:15:00.000Z",
        });
      }
      const text = (body.payload as { text?: string } | undefined)?.text ?? "";
      if (text.includes("Mechanical action permanently failed")) return new Response("journal unavailable", { status: 503 });
      reports.push(body);
      return Response.json({ seq: reports.length });
    }));
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    let resumes = 0;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      state.state.workers.a = {
        status: "idle",
        thread_id: "worker-a",
        worktree: join(root, "worker-a"),
        branch: "work/a",
        reporter_credential: "worker-token",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: join(root, "worker-a.reporter.conf"),
      };
      await state.save();
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => {
          resumes += 1;
          return running("worker-a", Promise.reject(new Error("resume crashed")));
        },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.execute({ actions: [
        { act: "rebrief_worker", node_id: "a", message: "Continue." },
        { act: "note", text: "Drain continued." },
      ] }, "envelope seq 12-12");
      for (let attempt = 0; attempt < 100 && state.state.pending_actions.length > 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }

      expect(resumes).toBe(3);
      expect(state.state.pending_actions).toEqual([]);
      expect(state.state.dead_letters).toEqual([
        expect.objectContaining({
          attempts: 3,
          permanent_failure: "resume crashed",
          failure_journal_error: expect.stringContaining("503"),
          action: { act: "rebrief_worker", node_id: "a", message: "Continue." },
        }),
      ]);
      expect(reports).toEqual([
        expect.objectContaining({ payload: { text: "Drain continued." } }),
      ]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a spawned child when persisting its process identity fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-partial-spawn-"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/reporter-credentials")) return Response.json({ seq: 1 });
      const body = JSON.parse(String(init?.body)) as { actor: string };
      return Response.json({ token: "worker-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
    }));
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    let terminations = 0;
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      const save = state.save.bind(state);
      let saves = 0;
      vi.spyOn(state, "save").mockImplementation(async () => {
        saves += 1;
        if (saves === 4) throw new Error("identity save failed");
        await save();
      });
      const codex = {
        startWorker: () => running("worker-a", undefined, async () => { terminations += 1; }),
        resumeWorker: () => { throw new Error("not used"); },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "a", brief: "Build A." }] });
      executor.beginShutdown();

      expect(terminations).toBe(1);
      expect(state.state.workers.a?.status).toBe("dead");
      expect(state.state.pending_actions).toEqual([
        expect.objectContaining({ attempts: 1, action: { act: "spawn_worker", node_id: "a", brief: "Build A." } }),
      ]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the intended reporter path before creation so restart removes a crash orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-reporter-crash-"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/reporter-credentials")) return Response.json({ seq: 1 });
      const body = JSON.parse(String(init?.body)) as { actor: string };
      return Response.json({
        token: "orphaned-worker-token",
        actor: body.actor,
        expires: "2099-08-30T10:15:00.000Z",
      });
    }));
    let reachCrash!: (path: string) => void;
    const crashReached = new Promise<string>((resolvePromise) => { reachCrash = resolvePromise; });
    let releaseCrash!: () => void;
    const crashBarrier = new Promise<void>((resolvePromise) => { releaseCrash = resolvePromise; });
    let resolveIdentity!: (identity: { pid: number; starttime: string }) => void;
    let firstState: StateStore | undefined;
    let reopened: StateStore | undefined;
    let firstExecutor: ActionExecutor | undefined;
    let recoveryExecutor: ActionExecutor | undefined;
    let launch: Promise<RunningCodex> | undefined;
    try {
      const bridgeConfig = { ...config(root), fleetMode: true };
      await initializeRepo(bridgeConfig.targetRepoPath);
      firstState = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      const save = firstState.save.bind(firstState);
      vi.spyOn(firstState, "save").mockImplementation(async () => {
        const worker = firstState!.state.workers["fleet:request-crash"];
        const persisted = existsSync(bridgeConfig.statePath)
          ? JSON.parse(readFileSync(bridgeConfig.statePath, "utf8")) as { workers?: Record<string, unknown> }
          : undefined;
        if (
          worker?.reporter_config_path &&
          existsSync(worker.reporter_config_path) &&
          !persisted?.workers?.["fleet:request-crash"]
        ) {
          reachCrash(worker.reporter_config_path);
          await crashBarrier;
          throw new Error("simulated bridge crash before worker state persistence");
        }
        await save();
      });
      const slot = new ExecutionSlot();
      const lease = await slot.acquire("fleet crash test");
      firstExecutor = new ActionExecutor(bridgeConfig, firstState, {
        startWorker: (_nodeId, _brief, _worktree, reporterConfigPath): RunningCodex => {
          reachCrash(reporterConfigPath);
          return {
            pid: 40_002,
            identity: new Promise((resolvePromise) => { resolveIdentity = resolvePromise; }),
            threadId: new Promise(() => undefined),
            completed: new Promise(() => undefined),
            begin: () => undefined,
            terminate: async () => undefined,
          };
        },
        resumeWorker: () => { throw new Error("not used"); },
      }, new TestLogger(), false, lockProcessStartTime, slot);
      launch = firstExecutor.spawnFleetWorker({
        requestId: "request-crash",
        projectId: bridgeConfig.projectId,
        nodeId: "node-crash",
        title: "Crash test",
        brief: "Exercise the reporter persistence boundary.",
        workerKey: "fleet:request-crash",
      }, lease);
      const reporterConfigPath = await Promise.race([
        crashReached,
        new Promise<never>((_resolvePromise, rejectPromise) => {
          setTimeout(() => rejectPromise(new Error("worker did not reach the reporter crash window")), 2_000);
        }),
      ]);
      expect(await readFile(reporterConfigPath, "utf8")).toContain("orphaned-worker-token");

      await firstState.close();
      reopened = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      recoveryExecutor = new ActionExecutor(bridgeConfig, reopened, {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => { throw new Error("not used"); },
      }, new TestLogger(), false, lockProcessStartTime, new ExecutionSlot());
      await recoveryExecutor.initialize();

      await expect(readFile(reporterConfigPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      firstExecutor?.beginShutdown();
      releaseCrash();
      resolveIdentity?.({ pid: 40_002, starttime: "worker-start" });
      await launch?.catch(() => undefined);
      await firstExecutor?.stop();
      await recoveryExecutor?.stop();
      await reopened?.close();
      if (firstState && firstState !== reopened) await firstState.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts a worker launch whose process identity never settles during shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-identity-shutdown-"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/reporter-credentials")) return Response.json({ seq: 1 });
      const body = JSON.parse(String(init?.body)) as { actor: string };
      return Response.json({ token: "worker-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
    }));
    let resolveIdentity!: (identity: { pid: number; starttime: string }) => void;
    let resolveThread!: (threadId: string) => void;
    let launched!: () => void;
    const launchStarted = new Promise<void>((resolvePromise) => { launched = resolvePromise; });
    let terminated = false;
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      const codex = {
        startWorker: (): RunningCodex => {
          launched();
          return {
            pid: 40_001,
            identity: new Promise((resolvePromise) => { resolveIdentity = resolvePromise; }),
            threadId: new Promise((resolvePromise) => { resolveThread = resolvePromise; }),
            completed: Promise.resolve({ stdout: "", stderr: "" }),
            begin: () => undefined,
            terminate: async () => { terminated = true; },
          };
        },
        resumeWorker: () => { throw new Error("not used"); },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      const execution = executor.execute({ actions: [{ act: "spawn_worker", node_id: "a", brief: "Build A." }] });
      await launchStarted;
      executor.beginShutdown();
      const stoppedPromptly = await Promise.race([
        execution.then(() => true),
        new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 150)),
      ]);
      resolveIdentity({ pid: 40_001, starttime: "worker-start" });
      resolveThread("worker-a");
      await execution;

      expect(stoppedPromptly).toBe(true);
      expect(terminated).toBe(true);
    } finally {
      await executor?.terminateAll();
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles mismatched processes and recreates renewal for matching live identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-reconcile-"));
    const issued: string[] = [];
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/reporter-credentials")) {
        const body = JSON.parse(String(init?.body)) as { actor: string };
        issued.push(body.actor);
        return Response.json({ token: "renewed-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
      }
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ seq: 1 });
    }));
    const processStartTime = async (pid: number): Promise<string | undefined> => {
      if (pid === process.pid) return "test-bridge-start";
      if (pid === 222) return "live-worker-start";
      return undefined;
    };
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, processStartTime);
      const staleReporterConfig = join(root, "stale.reporter.conf");
      await writeFile(staleReporterConfig, "header = \"Authorization: Bearer stale-token\"\n");
      state.state.workers.stale = {
        status: "live",
        thread_id: "stale-thread",
        worktree: join(root, "stale"),
        branch: "work/stale",
        reporter_credential: "stale-token",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: staleReporterConfig,
        pid: 111,
        process_start_time: "old-start",
      };
      state.state.workers.live = {
        status: "live",
        thread_id: "live-thread",
        worktree: join(root, "live"),
        branch: "work/live",
        pid: 222,
        process_start_time: "live-worker-start",
        reporter_credential: "old-token",
        reporter_expires: new Date(Date.now() + 100).toISOString(),
        reporter_config_path: join(root, "live.reporter.conf"),
      };
      await state.save();
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => { throw new Error("not used"); },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger(), false, processStartTime);
      await executor.initialize();
      for (let attempt = 0; attempt < 50 && issued.length === 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(state.state.workers.stale?.status).toBe("dead");
      expect(state.state.workers.stale?.thread_id).toBe("stale-thread");
      expect(issued).toEqual(["worker:live"]);
      expect(reports).toEqual([
        expect.objectContaining({ type: "JOURNAL_NOTE", payload: { text: expect.stringContaining("marked worker stale dead") } }),
      ]);
      await expect(readFile(staleReporterConfig, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(state.state.workers.live!.reporter_config_path!, "utf8")).toContain("renewed-token");
      expect((await stat(state.state.workers.live!.reporter_config_path!)).mode & 0o777).toBe(0o600);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the global lease when a recovered live worker process exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-recovered-worker-"));
    const child = (await import("node:child_process")).spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", rejectPromise);
    });
    const processStartTime = async (pid: number): Promise<string | undefined> => {
      if (pid === process.pid) return "test-bridge-start";
      if (pid !== child.pid) return undefined;
      try {
        process.kill(pid, 0);
        return "recovered-child-start";
      } catch {
        return undefined;
      }
    };
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = { ...config(root), fleetMode: true };
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, processStartTime);
      state.state.workers.live = {
        status: "live",
        thread_id: "live-thread",
        worktree: join(root, "live"),
        branch: "work/live",
        reporter_credential: "token",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        pid: child.pid!,
        process_start_time: "recovered-child-start",
      };
      await state.save();
      const slot = new (await import("../src/slot.js")).ExecutionSlot();
      executor = new ActionExecutor(bridgeConfig, state, {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => { throw new Error("not used"); },
      }, new TestLogger(), false, processStartTime, slot);
      await executor.initialize();
      expect(slot.owner).toBe("recovered worker live");

      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      for (let attempt = 0; attempt < 100 && slot.owner !== undefined; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(slot.owner).toBeUndefined();
      expect(state.state.workers.live?.status).toBe("idle");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await executor?.terminateAll();
      await executor?.stop();
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a recovered worker lookup rejection and releases the global lease after permanent failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-recovered-lookup-failure-"));
    const child = (await import("node:child_process")).spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", rejectPromise);
    });
    let childLookups = 0;
    const processStartTime = async (pid: number): Promise<string | undefined> => {
      if (pid === process.pid) return "test-bridge-start";
      if (pid !== child.pid) return undefined;
      childLookups += 1;
      if (childLookups === 1) return "recovered-child-start";
      throw new Error("injected ps spawn failure");
    };
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = { ...config(root), fleetMode: true };
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, processStartTime);
      const reporterConfigPath = join(root, "recovered.reporter.conf");
      await writeFile(reporterConfigPath, "header = \"Authorization: Bearer recovered-token\"\n");
      state.state.workers.live = {
        status: "live",
        thread_id: "live-thread",
        worktree: join(root, "live"),
        branch: "work/live",
        reporter_credential: "recovered-token",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: reporterConfigPath,
        pid: child.pid!,
        process_start_time: "recovered-child-start",
      };
      await state.save();
      const slot = new ExecutionSlot();
      executor = new ActionExecutor(bridgeConfig, state, {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => { throw new Error("not used"); },
      }, new TestLogger(), false, processStartTime, slot);
      await executor.initialize();
      expect(slot.owner).toBe("recovered worker live");

      for (let attempt = 0; attempt < 100 && slot.owner !== undefined; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(childLookups).toBeGreaterThanOrEqual(4);
      expect(slot.owner).toBeUndefined();
      expect(state.state.workers.live).toMatchObject({ status: "idle", thread_id: "live-thread" });
      expect(state.state.workers.live?.pid).toBeUndefined();
      await expect(readFile(reporterConfigPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      executor?.beginShutdown();
      await executor?.stop();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a worker reporter configuration when the worker reaches a terminal process state", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-reporter-cleanup-"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/reporter-credentials")) return Response.json({ seq: 1 });
      const body = JSON.parse(String(init?.body)) as { actor: string };
      return Response.json({ token: "worker-token", actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
    }));
    let finish!: () => void;
    const completed = new Promise<{ stdout: string; stderr: string }>((resolvePromise) => {
      finish = () => resolvePromise({ stdout: "", stderr: "" });
    });
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, lockProcessStartTime);
      executor = new ActionExecutor(bridgeConfig, state, {
        startWorker: () => running("worker-a", completed),
        resumeWorker: () => { throw new Error("not used"); },
      }, new TestLogger());
      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "a", brief: "Build A." }] });
      const reporterConfigPath = state.state.workers.a!.reporter_config_path!;
      expect(await readFile(reporterConfigPath, "utf8")).toContain("worker-token");

      finish();
      for (let attempt = 0; attempt < 100 && state.state.workers.a?.status !== "idle"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      await expect(readFile(reporterConfigPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finish();
      await executor?.terminateAll();
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not schedule or persist renewal work that completes during shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-renewal-stop-"));
    let resolveCredential!: (response: Response) => void;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolvePromise) => { markRequested = resolvePromise; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      markRequested();
      return new Promise<Response>((resolvePromise) => { resolveCredential = resolvePromise; });
    }));
    const processStartTime = async (pid: number): Promise<string | undefined> => {
      if (pid === process.pid) return "test-bridge-start";
      if (pid === 333) return "live-worker-start";
      return undefined;
    };
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId, processStartTime);
      state.state.workers.live = {
        status: "live",
        thread_id: "live-thread",
        worktree: join(root, "live"),
        branch: "work/live",
        pid: 333,
        process_start_time: "live-worker-start",
        reporter_credential: "old-token",
        reporter_expires: new Date(Date.now() + 100).toISOString(),
        reporter_config_path: join(root, "live.reporter.conf"),
      };
      await state.save();
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: () => { throw new Error("not used"); },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger(), false, processStartTime);
      await executor.initialize();
      await requested;
      executor.beginShutdown();
      resolveCredential(Response.json({
        token: "new-token",
        actor: "worker:live",
        expires: "2099-08-30T10:15:00.000Z",
      }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

      expect(state.state.workers.live?.reporter_credential).toBe("old-token");
      expect(state.state.workers.live?.reporter_expires).not.toBe("2099-08-30T10:15:00.000Z");
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });
});
