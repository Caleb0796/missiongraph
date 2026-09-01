import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CodexClient,
  codexChildEnvironment,
  retainOutput,
  workerChildEnvironment,
} from "../src/codex.js";
import { workerBrief } from "../src/prompts.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

describe("CodexClient", () => {
  it("allowlists child environment variables and excludes MissionGraph master secrets", async () => {
    const environment = codexChildEnvironment(
      { MG_REPORT_URL: "http://127.0.0.1/report", MG_NODE_ID: "node-a" },
      {
        PATH: "/usr/bin:/bin",
        HOME: "/home/test",
        CODEX_HOME: "/home/test/.codex",
        CODEX_API_KEY: "codex-provider",
        OPENAI_API_KEY: "openai-provider",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_ACCESS_TOKEN: "openai-token",
        SSL_CERT_FILE: "/certs/root.pem",
        NODE_EXTRA_CA_CERTS: "/certs/extra.pem",
        HTTPS_PROXY: "http://proxy.test",
        REPORTER_TOKEN: "master-reporter",
        MG_REPORTER_CREDENTIAL: "master-credential",
        MG_VISITOR_TOKEN: "visitor-secret",
        MG_OTHER_SECRET: "also-secret",
      },
    );

    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/test",
      CODEX_HOME: "/home/test/.codex",
      OPENAI_BASE_URL: "https://api.example.test/v1",
      SSL_CERT_FILE: "/certs/root.pem",
      NODE_EXTRA_CA_CERTS: "/certs/extra.pem",
      HTTPS_PROXY: "http://proxy.test",
      MG_REPORT_URL: "http://127.0.0.1/report",
      MG_NODE_ID: "node-a",
    });
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.OPENAI_BASE_URL).toBe("https://api.example.test/v1");

    const root = await mkdtemp(join(tmpdir(), "missiongraph-codex-env-"));
    const previous = {
      REPORTER_TOKEN: process.env.REPORTER_TOKEN,
      MG_REPORTER_CREDENTIAL: process.env.MG_REPORTER_CREDENTIAL,
      MG_VISITOR_TOKEN: process.env.MG_VISITOR_TOKEN,
    };
    try {
      process.env.REPORTER_TOKEN = "master-reporter";
      process.env.MG_REPORTER_CREDENTIAL = "master-credential";
      process.env.MG_VISITOR_TOKEN = "visitor-secret";
      const bridgeConfig = config(root);
      await initializeRepo(bridgeConfig.targetRepoPath);
      const client = new CodexClient(bridgeConfig, new TestLogger(), true);
      await expect(client.startSupervisor("MISSIONGRAPH SUPERVISOR\nReturn JSON.").completed).resolves.toMatchObject({
        threadId: "mock-supervisor",
      });
      const worker = client.startWorker("node-a", "Node ID: node-a\nBuild A.", bridgeConfig.targetRepoPath, join(root, "reporter.conf"));
      (worker as typeof worker & { begin?: () => void }).begin?.();
      await expect(worker.threadId).resolves.toBe("mock-worker-node-a");
      await worker.completed;
      const resumed = client.resumeWorker(
        "node-a",
        "mock-worker-node-a",
        "Continue.",
        bridgeConfig.targetRepoPath,
        join(root, "reporter.conf"),
      );
      resumed.begin();
      await expect(resumed.completed).resolves.toMatchObject({ threadId: "mock-worker-node-a" });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a worker behind a launch handshake until its process identity can be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-codex-handshake-"));
    const bridgeConfig = config(root);
    await initializeRepo(bridgeConfig.targetRepoPath);
    const client = new CodexClient(bridgeConfig, new TestLogger(), true, async (pid) => `test-start-${pid}`);
    const worker = client.startWorker(
      "node-a",
      "Node ID: node-a\nBuild A.",
      bridgeConfig.targetRepoPath,
      join(root, "reporter.conf"),
    ) as ReturnType<CodexClient["startWorker"]> & { begin?: () => void };
    const beforeBegin = await Promise.race([
      worker.threadId.then(() => "started" as const),
      new Promise<"waiting">((resolvePromise) => setTimeout(() => resolvePromise("waiting"), 75)),
    ]);
    if (beforeBegin === "waiting") {
      worker.begin!();
      await expect(worker.threadId).resolves.toBe("mock-worker-node-a");
    }
    await worker.completed;
    await client.stop();
    await rm(root, { recursive: true, force: true });
    expect(beforeBegin).toBe("waiting");
    expect(worker.begin).toBeTypeOf("function");
  });

  it("passes every MissionGraph environment variable referenced by the worker prompt", () => {
    const bridgeConfig = config("/tmp/missiongraph-worker-environment");
    const promptVariables = [...new Set(
      workerBrief("node-a", "Build A.", bridgeConfig.targetRepoPath).match(/\bMG_[A-Z0-9_]+\b/g) ?? [],
    )].sort();
    const childVariables = Object.keys(codexChildEnvironment(
      workerChildEnvironment(bridgeConfig, "node-a", "/tmp/reporter.conf"),
      {},
    )).sort();

    expect(childVariables).toEqual(promptVariables);
    expect(workerChildEnvironment(bridgeConfig, "node-a", "/tmp/reporter.conf")).toEqual({
      MG_REPORT_URL: `${bridgeConfig.serverUrl}/api/p/${bridgeConfig.projectId}/report`,
      MG_REPORTER_CONFIG: "/tmp/reporter.conf",
      MG_WORKER_ACTOR: "worker:node-a",
      MG_NODE_ID: "node-a",
    });
  });

  it("retains only the newest two megabytes of child output", () => {
    const retained = retainOutput("a".repeat(2 * 1024 * 1024), Buffer.from("tail"));
    expect(Buffer.byteLength(retained)).toBe(2 * 1024 * 1024);
    expect(retained.endsWith("tail")).toBe(true);
  });

  it("applies the shell secret filter to every invocation and keeps resume sandbox config-compatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-codex-args-"));
    try {
      const bridgeConfig = config(root);
      const client = new CodexClient(bridgeConfig, new TestLogger(), true) as unknown as {
        supervisorStartArgs(brief: string): string[];
        workerStartArgs(brief: string, worktree: string): string[];
        supervisorResumeArgs(threadId: string, message: string): string[];
        workerResumeArgs(threadId: string, message: string): string[];
      };
      const starts = [
        client.supervisorStartArgs("brief"),
        client.workerStartArgs("brief", root),
      ];
      const resumes = [
        client.supervisorResumeArgs("thread-1", "envelope"),
        client.workerResumeArgs("thread-2", "message"),
      ];
      for (const args of [...starts, ...resumes]) {
        expect(args).toContain('shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*"]');
      }
      for (const args of resumes) {
        expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
        expect(args).not.toContain("-s");
        expect(args.some((argument) => argument.startsWith("sandbox_mode="))).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
