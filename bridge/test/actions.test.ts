import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ActionExecutor } from "../src/actions.js";
import { CodexClient } from "../src/codex.js";
import { StateStore } from "../src/state.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

describe("ActionExecutor", () => {
  it("creates a worktree, starts the mock worker, and resumes cooperative actions", async () => {
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
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      const logger = new TestLogger();
      const state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId);
      const codex = new CodexClient(bridgeConfig, logger, true);
      const executor = new ActionExecutor(bridgeConfig, state, codex, logger);

      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A." }] });
      expect(state.state.workers["node-a"]).toMatchObject({
        thread_id: "mock-worker-node-a",
        branch: expect.stringMatching(/^work\/node-a-/),
        worktree: expect.stringContaining("repo-node-a-"),
        reporter_credential: "worker-token-1",
        reporter_expires: "2099-08-30T10:15:00.000Z",
        reporter_config_path: expect.stringMatching(/\.reporter\.conf$/),
      });

      state.state.workers["node-a"]!.reporter_expires = "2000-01-01T00:00:00.000Z";

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
        reporter_credential: "worker-token-2",
        reporter_expires: "2099-08-30T10:15:00.000Z",
      });
      expect(reports).toEqual([
        {
          authorization: "Bearer reporter-token",
          body: expect.objectContaining({
            actor: "supervisor",
            type: "JOURNAL_NOTE",
            payload: { text: "Supervisor recorded a bridge decision." },
          }),
        },
      ]);
      expect(logger.errorMessages).toEqual([]);
    } finally {
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
    try {
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      const logger = new TestLogger();
      const state = await StateStore.open(bridgeConfig.statePath, bridgeConfig.projectId);
      const codex = {
        startWorker: () => ({
          pid: -1,
          threadId: Promise.resolve("long-worker-thread"),
          completed,
          terminate: () => completeWorker(),
        }),
        resumeWorker: async () => ({ stdout: "", stderr: "" }),
      };
      const executor = new ActionExecutor(bridgeConfig, state, codex, logger);

      await executor.execute({ actions: [{ act: "spawn_worker", node_id: "node-a", brief: "Build A." }] });
      for (let attempt = 0; attempt < 50 && issued.length < 2; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      const worker = state.state.workers["node-a"]!;
      expect(issued).toEqual(["worker-token-1", "worker-token-2"]);
      expect(worker.reporter_credential).toBe("worker-token-2");
      expect(await readFile(worker.reporter_config_path!, "utf8")).toContain("Bearer worker-token-2");
      expect((await stat(worker.reporter_config_path!)).mode & 0o777).toBe(0o600);
      executor.stop();
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });
});
