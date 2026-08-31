import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { bridgePackageRoot, type BridgeConfig } from "./config.js";
import { parseThreadId } from "./decision.js";
import {
  identifyProcess,
  readProcessStartTime,
  terminateProcess,
  type ProcessIdentity,
  type ProcessStartTimeLookup,
} from "./process.js";
import type { Logger } from "./types.js";

export interface CodexResult {
  stdout: string;
  stderr: string;
  threadId?: string;
}

export interface RunningCodex {
  pid: number;
  identity: Promise<ProcessIdentity>;
  threadId: Promise<string>;
  completed: Promise<CodexResult>;
  terminate(): Promise<void>;
}

interface Command {
  executable: string;
  prefix: string[];
}

const outputRetentionBytes = 2 * 1024 * 1024;
const lineBufferRetentionBytes = 64 * 1024;
const childSourceVariables = new Set([
  "PATH",
  "HOME",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
const scopedWorkerVariables = new Set(["MG_REPORT_URL", "MG_REPORTER_CONFIG", "MG_WORKER_ACTOR", "MG_NODE_ID"]);

export function workerChildEnvironment(
  config: BridgeConfig,
  nodeId: string,
  reporterConfigPath: string,
): NodeJS.ProcessEnv {
  return {
    MG_REPORT_URL: `${config.serverUrl}/api/p/${encodeURIComponent(config.projectId)}/report`,
    MG_REPORTER_CONFIG: reporterConfigPath,
    MG_WORKER_ACTOR: `worker:${nodeId}`,
    MG_NODE_ID: nodeId,
  };
}

export function codexChildEnvironment(
  environment: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = Object.fromEntries(
    Object.entries(source).filter(([name, value]) =>
      value !== undefined &&
      name !== "REPORTER_TOKEN" &&
      !name.startsWith("MG_") &&
      (childSourceVariables.has(name) || name.startsWith("CODEX_") || name.startsWith("OPENAI_")),
    ),
  );
  const scoped = Object.fromEntries(Object.entries(environment).filter(([name]) => scopedWorkerVariables.has(name)));
  return { ...allowed, ...scoped };
}

export function retainOutput(current: string, chunk: Buffer, maximumBytes = outputRetentionBytes): string {
  const combined = Buffer.concat([Buffer.from(current), chunk]);
  return combined.subarray(Math.max(0, combined.length - maximumBytes)).toString();
}

export class CodexClient {
  private readonly command: Command;
  private readonly children = new Set<RunningCodex>();
  private stopping = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    dryRun = false,
    private readonly processStartTime: ProcessStartTimeLookup = readProcessStartTime,
  ) {
    this.command = dryRun
      ? { executable: process.execPath, prefix: [resolve(bridgePackageRoot, "mock-codex.mjs")] }
      : { executable: config.codexBinaryPath, prefix: [] };
  }

  startSupervisor(brief: string): RunningCodex {
    return this.start(
      [
        "exec",
        brief,
        "-s",
        "read-only",
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

  resumeSupervisor(threadId: string, envelope: string): RunningCodex {
    return this.start(this.supervisorResumeArgs(threadId, envelope), this.config.targetRepoPath);
  }

  startWorker(nodeId: string, brief: string, worktree: string, reporterConfigPath: string): RunningCodex {
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
      workerChildEnvironment(this.config, nodeId, reporterConfigPath),
    );
    void running.completed.catch(() => undefined);
    return running;
  }

  resumeWorker(
    nodeId: string,
    threadId: string,
    message: string,
    worktree: string,
    reporterConfigPath: string,
  ): RunningCodex {
    return this.start(
      this.workerResumeArgs(threadId, message),
      worktree,
      workerChildEnvironment(this.config, nodeId, reporterConfigPath),
    );
  }

  private supervisorResumeArgs(threadId: string, message: string): string[] {
    return [
      "exec",
      "resume",
      threadId,
      message,
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      "mcp_servers={}",
      "-c",
      `model_reasoning_effort=${JSON.stringify(this.config.effort)}`,
      "-m",
      this.config.model,
      "--json",
    ];
  }

  private workerResumeArgs(threadId: string, message: string): string[] {
    return [
      "exec",
      "resume",
      threadId,
      message,
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "mcp_servers={}",
      "-c",
      `model_reasoning_effort=${JSON.stringify(this.config.effort)}`,
      "-m",
      this.config.model,
      "--json",
    ];
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled([...this.children].map((child) => child.terminate()));
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error(`codex child termination failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  }

  private start(args: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): RunningCodex {
    if (this.stopping) throw new Error("codex client is shutting down");
    const child = spawn(this.command.executable, [...this.command.prefix, ...args], {
      cwd,
      env: codexChildEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let resolveThread!: (threadId: string) => void;
    let rejectThread!: (error: Error) => void;
    let settledThread = false;
    let observedThreadId: string | undefined;
    const threadId = new Promise<string>((resolvePromise, rejectPromise) => {
      resolveThread = resolvePromise;
      rejectThread = rejectPromise;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = retainOutput(stdout, chunk);
      buffered = retainOutput(buffered, chunk, lineBufferRetentionBytes);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const found = parseThreadId(line);
        if (found && !settledThread) {
          observedThreadId = found;
          settledThread = true;
          resolveThread(found);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = retainOutput(stderr, chunk);
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
          observedThreadId = found;
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
        const resultThreadId = found ?? observedThreadId;
        resolvePromise({ stdout, stderr, ...(resultThreadId ? { threadId: resultThreadId } : {}) });
      });
    });
    let termination: Promise<void> | undefined;
    const pid = child.pid ?? -1;
    const identity = identifyProcess(pid, this.processStartTime);
    void identity.catch(() => undefined);
    const running: RunningCodex = {
      pid,
      identity,
      threadId,
      completed,
      terminate: () => termination ??= identity.then(async (current) => {
        await terminateProcess(current, { lookup: this.processStartTime });
        await completed.catch(() => undefined);
      }),
    };
    this.children.add(running);
    void completed.catch(() => undefined).finally(() => this.children.delete(running));
    return running;
  }
}
