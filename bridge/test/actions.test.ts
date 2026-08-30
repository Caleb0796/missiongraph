import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ActionExecutor } from "../src/actions.js";
import { StateStore } from "../src/state.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

describe("ActionExecutor", () => {
  it("persists spawning state, renews before resume, and makes live spawns idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-actions-"));
    const issued: string[] = [];
    const reports: { authorization: string | null; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/reporter-credentials")) {
        const body = JSON.parse(String(init?.body)) as { actor: string };
        const token = `worker-token-${issued.length + 1}`;
        issued.push(token);
        return Response.json({ token, actor: body.actor, expires: "2099-08-30T10:15:00.000Z" });
      }
      if (url.endsWith("/report")) {
        const headers = new Headers(init?.headers);
        reports.push({
          authorization: headers.get("authorization"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ seq: 1 });
      }
      return new Response("not found", { status: 404 });
    }));
    let completeWorker!: () => void;
    const completed = new Promise<{ stdout: string; stderr: string }>((resolvePromise) => {
      completeWorker = () => resolvePromise({ stdout: "", stderr: "" });
    });
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      const logger = new TestLogger();
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId);
      const resumed: string[] = [];
      const codex = {
        startWorker: () => {
          expect(state?.state.workers["node-a"]?.status).toBe("spawning");
          expect(JSON.parse(readFileSync(bridgeConfig.statePath, "utf8"))).toMatchObject({
            workers: { "node-a": { status: "spawning" } },
          });
          return {
            pid: -1,
            threadId: Promise.resolve("worker-node-a"),
            completed,
            terminate: async () => completeWorker(),
          };
        },
        resumeWorker: async (_nodeId: string, _threadId: string, message: string) => {
          resumed.push(message);
          return { stdout: "", stderr: "" };
        },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, logger);

      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A." }] });
      expect(state.state.workers["node-a"]).toMatchObject({
        status: "live",
        thread_id: "worker-node-a",
        branch: expect.stringMatching(/^work\/node-a-/),
        worktree: expect.stringContaining("repo-node-a-"),
        reporter_credential: "worker-token-1",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: expect.stringMatching(/\.reporter\.conf$/),
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
      expect(state.state.workers["node-a"]).toMatchObject({
        status: "dead",
        reporter_credential: "worker-token-2",
        reporter_expires: "2099-08-30T10:15:00.000Z",
      });
      expect(resumed).toHaveLength(3);
      expect(reports.map((report) => report.body)).toEqual([
        expect.objectContaining({ type: "JOURNAL_NOTE", payload: { text: expect.stringContaining("idempotent no-op") } }),
        expect.objectContaining({ type: "JOURNAL_NOTE", payload: { text: "Supervisor recorded a bridge decision." } }),
      ]);
      expect(logger.errorMessages).toEqual([]);
    } finally {
      completeWorker();
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renews the reporter config while a worker is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-renewal-"));
    const issued: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/reporter-credentials")) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init?.body)) as { actor: string };
      const token = `worker-token-${issued.length + 1}`;
      issued.push(token);
      return Response.json({
        token,
        actor: body.actor,
        expires: issued.length === 1 ? new Date(Date.now() + 100).toISOString() : "2099-08-30T10:15:00.000Z",
      });
    }));
    let completeWorker!: () => void;
    const completed = new Promise<{ stdout: string; stderr: string }>((resolvePromise) => {
      completeWorker = () => resolvePromise({ stdout: "", stderr: "" });
    });
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      const logger = new TestLogger();
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId);
      const codex = {
        startWorker: () => ({
          pid: -1,
          threadId: Promise.resolve("long-worker-thread"),
          completed,
          terminate: async () => completeWorker(),
        }),
        resumeWorker: async () => ({ stdout: "", stderr: "" }),
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, logger);

      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A." }] });
      for (let attempt = 0; attempt < 50 && issued.length < 2; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      const worker = state.state.workers["node-a"]!;
      expect(issued).toEqual(["worker-token-1", "worker-token-2"]);
      expect(worker.reporter_credential).toBe("worker-token-2");
      expect(await readFile(worker.reporter_config_path!, "utf8")).toContain("Bearer worker-token-2");
      expect((await stat(worker.reporter_config_path!)).mode & 0o777).toBe(0o600);
    } finally {
      completeWorker();
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles missing processes and recreates startup renewal timers", async () => {
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
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId);
      state.state.workers.stale = {
        status: "live",
        thread_id: "stale-thread",
        worktree: join(root, "stale"),
        branch: "work/stale",
        pid: 999_999,
      };
      state.state.workers.live = {
        status: "live",
        thread_id: "live-thread",
        worktree: join(root, "live"),
        branch: "work/live",
        pid: process.pid,
        reporter_credential: "old-token",
        reporter_expires: new Date(Date.now() + 100).toISOString(),
        reporter_config_path: join(root, "live.reporter.conf"),
      };
      await state.save();
      const codex = {
        startWorker: () => { throw new Error("not used"); },
        resumeWorker: async () => ({ stdout: "", stderr: "" }),
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.initialize();
      for (let attempt = 0; attempt < 50 && issued.length === 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(state.state.workers.stale?.status).toBe("dead");
      expect(issued).toEqual(["worker:live"]);
      expect(reports).toEqual([
        expect.objectContaining({ type: "JOURNAL_NOTE", payload: { text: expect.stringContaining("marked worker stale dead") } }),
      ]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("journals mechanical action failures instead of swallowing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-action-failure-"));
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ seq: 1 });
    }));
    let state: StateStore | undefined;
    let executor: ActionExecutor | undefined;
    try {
      const bridgeConfig = config(root);
      state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId);
      state.state.workers.a = {
        status: "live",
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
        resumeWorker: async () => { throw new Error("resume crashed"); },
      };
      executor = new ActionExecutor(bridgeConfig, state, codex, new TestLogger());
      await executor.execute({ actions: [{ act: "rebrief_worker", node_id: "a", message: "Continue." }] });

      expect(reports).toEqual([
        expect.objectContaining({
          type: "JOURNAL_NOTE",
          payload: { text: "Mechanical action rebrief_worker for node a failed: resume crashed" },
        }),
      ]);
    } finally {
      await executor?.stop();
      await state?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });
});
