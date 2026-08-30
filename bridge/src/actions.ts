import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

import type { CodexClient, RunningCodex } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import { workerBrief } from "./prompts.js";
import { ReporterClient, reporterPayload } from "./reporter.js";
import type { StateStore } from "./state.js";
import type { Logger, SupervisorAction, SupervisorDecision } from "./types.js";

async function runGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
    });
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node";
}

export class ActionExecutor {
  private readonly running = new Map<string, RunningCodex>();
  private readonly reporter: ReporterClient;

  constructor(
    private readonly config: BridgeConfig,
    private readonly stateStore: StateStore,
    private readonly codex: CodexClient,
    private readonly logger: Logger,
  ) {
    this.reporter = new ReporterClient(config);
  }

  async execute(decision: SupervisorDecision): Promise<void> {
    for (const action of decision.actions) {
      try {
        await this.executeOne(action);
      } catch (error) {
        this.logger.error(`${action.act} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async executeOne(action: SupervisorAction): Promise<void> {
    switch (action.act) {
      case "spawn_worker":
        await this.spawnWorker(action.node_id, action.brief);
        return;
      case "rebrief_worker":
        await this.resumeWorker(action.node_id, action.message);
        return;
      case "pause_worker":
        await this.resumeWorker(action.node_id, "Pause cooperatively at the next safe point and report PAUSE_ACKED.");
        return;
      case "resume_worker":
        await this.resumeWorker(action.node_id, "Resume the assigned MissionGraph task and continue required reporting.");
        return;
      case "kill_worker":
        await this.killWorker(action.node_id);
        return;
      case "note":
        await this.reporter.post(reporterPayload("supervisor", "JOURNAL_NOTE", { text: action.text }));
    }
  }

  private async spawnWorker(nodeId: string, brief: string): Promise<void> {
    if (this.stateStore.state.workers[nodeId]) {
      this.logger.warn(`spawn_worker ignored because node ${nodeId} already has a worker session`);
      return;
    }
    const suffix = randomUUID().slice(0, 8);
    const nodeSlug = slug(nodeId);
    const branch = `work/${nodeSlug}-${suffix}`;
    const root = join(dirname(this.config.targetRepoPath), ".missiongraph-worktrees");
    const worktree = join(root, `${basename(this.config.targetRepoPath)}-${nodeSlug}-${suffix}`);
    await mkdir(root, { recursive: true });
    await runGit(["worktree", "add", worktree, "-b", branch], this.config.targetRepoPath);
    const running = this.codex.startWorker(nodeId, workerBrief(nodeId, brief, worktree), worktree);
    const threadId = await running.threadId;
    this.running.set(nodeId, running);
    this.stateStore.state.workers[nodeId] = {
      thread_id: threadId,
      worktree,
      branch,
      ...(running.pid > 0 ? { pid: running.pid } : {}),
    };
    await this.stateStore.save();
    this.logger.info(`spawned worker ${nodeId} as thread ${threadId} in ${worktree}`);
    void running.completed
      .catch((error: unknown) => {
        this.logger.error(`worker ${nodeId} process ended with error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(async () => {
        if (this.running.get(nodeId) !== running) return;
        this.running.delete(nodeId);
        const state = this.stateStore.state.workers[nodeId];
        if (state) delete state.pid;
        await this.stateStore.save();
      });
  }

  private async resumeWorker(nodeId: string, message: string): Promise<void> {
    const worker = this.stateStore.state.workers[nodeId];
    if (!worker) {
      this.logger.warn(`worker action ignored because node ${nodeId} has no tracked session`);
      return;
    }
    await this.codex.resumeWorker(nodeId, worker.thread_id, message, worker.worktree);
  }

  private async killWorker(nodeId: string): Promise<void> {
    try {
      await this.resumeWorker(nodeId, "Stop cooperatively at the next safe point, report final status, and exit.");
    } finally {
      this.running.get(nodeId)?.terminate();
    }
  }
}
