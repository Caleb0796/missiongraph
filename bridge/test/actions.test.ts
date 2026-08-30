import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ActionExecutor } from "../src/actions.js";
import type { RunningCodex } from "../src/codex.js";
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
          return {
            ...running("worker-node-a", initialCompleted, async () => completeInitial()),
            threadId: initialThread,
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

      expect(issued).toEqual(["worker-token-1", "worker-token-2"]);
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
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
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
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
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
      state.state.workers.stale = {
        status: "live",
        thread_id: "stale-thread",
        worktree: join(root, "stale"),
        branch: "work/stale",
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
      expect(await readFile(state.state.workers.live!.reporter_config_path!, "utf8")).toContain("renewed-token");
      expect((await stat(state.state.workers.live!.reporter_config_path!)).mode & 0o777).toBe(0o600);
    } finally {
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
