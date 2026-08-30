import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ActionExecutor } from "../src/actions.js";
import { CodexClient } from "../src/codex.js";
import { StateStore } from "../src/state.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

describe("ActionExecutor", () => {
  it("creates a worktree, starts the mock worker, and resumes cooperative actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-actions-"));
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
      });

      await executor.execute({
        actions: [
          { act: "rebrief_worker", node_id: "node-a", message: "Use the new API." },
          { act: "pause_worker", node_id: "node-a" },
          { act: "resume_worker", node_id: "node-a" },
          { act: "kill_worker", node_id: "node-a" },
        ],
      });
      expect(logger.errorMessages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
