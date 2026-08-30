import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "./config.js";
import { parseThreadId } from "./decision.js";
import type { Logger } from "./types.js";

export interface CodexResult {
  stdout: string;
  stderr: string;
  threadId?: string;
}

export interface RunningCodex {
  pid: number;
  threadId: Promise<string>;
  completed: Promise<CodexResult>;
  terminate(): void;
}

interface Command {
  executable: string;
  prefix: string[];
}

const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class CodexClient {
  private readonly command: Command;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    dryRun = false,
  ) {
    this.command = dryRun
      ? { executable: process.execPath, prefix: [resolve(bridgeRoot, "mock-codex.mjs")] }
      : { executable: config.codexBinaryPath, prefix: [] };
  }

  async startSupervisor(brief: string): Promise<CodexResult> {
    return this.collect(
      [
        "exec",
        brief,
        "-s",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        "mcp_servers={}",
        "-c",
        `model_reasoning_effort=${JSON.stringify(this.config.effort)}`,
        "-m",
        this.config.model,
        "--json",
      ],
      this.config.targetRepoPath,
    );
  }

  async resumeSupervisor(threadId: string, envelope: string): Promise<CodexResult> {
    return this.collect(this.resumeArgs(threadId, envelope), this.config.targetRepoPath);
  }

  startWorker(nodeId: string, brief: string, worktree: string): RunningCodex {
    const running = this.start(
      [
        "exec",
        brief,
        "-C",
        worktree,
        "-s",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        "mcp_servers={}",
        "-c",
        `model_reasoning_effort=${JSON.stringify(this.config.effort)}`,
        "-m",
        this.config.model,
        "--json",
      ],
      this.config.targetRepoPath,
      {
        MG_REPORT_URL: `${this.config.serverUrl}/api/p/${encodeURIComponent(this.config.projectId)}/report`,
        MG_REPORTER_CREDENTIAL: this.config.reporterCredential,
        MG_WORKER_ACTOR: `worker:${nodeId}`,
        MG_NODE_ID: nodeId,
      },
    );
    void running.completed.catch(() => undefined);
    return running;
  }

  async resumeWorker(nodeId: string, threadId: string, message: string, worktree: string): Promise<CodexResult> {
    return this.collect(this.resumeArgs(threadId, message), worktree, {
      MG_REPORT_URL: `${this.config.serverUrl}/api/p/${encodeURIComponent(this.config.projectId)}/report`,
      MG_REPORTER_CREDENTIAL: this.config.reporterCredential,
      MG_WORKER_ACTOR: `worker:${nodeId}`,
      MG_NODE_ID: nodeId,
    });
  }

  private resumeArgs(threadId: string, message: string): string[] {
    return [
      "exec",
      "resume",
      threadId,
      message,
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "mcp_servers={}",
      "--json",
    ];
  }

  private async collect(args: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): Promise<CodexResult> {
    const running = this.start(args, cwd, environment);
    void running.threadId.catch(() => undefined);
    return running.completed;
  }

  private start(args: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): RunningCodex {
    const child = spawn(this.command.executable, [...this.command.prefix, ...args], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let resolveThread!: (threadId: string) => void;
    let rejectThread!: (error: Error) => void;
    let settledThread = false;
    const threadId = new Promise<string>((resolvePromise, rejectPromise) => {
      resolveThread = resolvePromise;
      rejectThread = rejectPromise;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      buffered += text;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const found = parseThreadId(line);
        if (found && !settledThread) {
          settledThread = true;
          resolveThread(found);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const completed = new Promise<CodexResult>((resolvePromise, rejectPromise) => {
      child.once("error", (error) => {
        if (!settledThread) {
          settledThread = true;
          rejectThread(error);
        }
        rejectPromise(error);
      });
      child.once("close", (code, signal) => {
        const found = parseThreadId(stdout);
        if (found && !settledThread) {
          settledThread = true;
          resolveThread(found);
        }
        if (code !== 0) {
          const error = new Error(
            `codex exited with ${code === null ? `signal ${signal}` : `code ${code}`}${stderr ? `: ${stderr.trim()}` : ""}`,
          );
          if (!settledThread) {
            settledThread = true;
            rejectThread(error);
          }
          rejectPromise(error);
          return;
        }
        if (!settledThread) {
          settledThread = true;
          rejectThread(new Error("codex JSONL did not contain thread.started"));
        }
        if (stderr.trim()) this.logger.warn(`codex stderr: ${stderr.trim()}`);
        resolvePromise({ stdout, stderr, ...(found ? { threadId: found } : {}) });
      });
    });
    return {
      pid: child.pid ?? -1,
      threadId,
      completed,
      terminate: () => child.kill("SIGTERM"),
    };
  }
}
