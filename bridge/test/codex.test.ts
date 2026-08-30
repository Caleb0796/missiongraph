import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CodexClient, codexChildEnvironment, retainOutput } from "../src/codex.js";
import { config, initializeRepo, TestLogger } from "./helpers.js";

describe("CodexClient", () => {
  it("allowlists child environment variables and excludes MissionGraph master secrets", async () => {
    const environment = codexChildEnvironment(
      { MG_NODE_ID: "node-a" },
      {
        PATH: "/usr/bin:/bin",
        HOME: "/home/test",
        CODEX_HOME: "/home/test/.codex",
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
      MG_NODE_ID: "node-a",
    });

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
      await expect(client.startSupervisor("MISSIONGRAPH SUPERVISOR\nReturn JSON.")).resolves.toMatchObject({
        threadId: "mock-supervisor",
      });
      const worker = client.startWorker("node-a", "Node ID: node-a\nBuild A.", bridgeConfig.targetRepoPath, join(root, "reporter.conf"));
      await expect(worker.threadId).resolves.toBe("mock-worker-node-a");
      await worker.completed;
      await expect(
        client.resumeWorker("node-a", "mock-worker-node-a", "Continue.", bridgeConfig.targetRepoPath, join(root, "reporter.conf")),
      ).resolves.toMatchObject({ threadId: "mock-worker-node-a" });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains only the newest two megabytes of child output", () => {
    const retained = retainOutput("a".repeat(2 * 1024 * 1024), Buffer.from("tail"));
    expect(Buffer.byteLength(retained)).toBe(2 * 1024 * 1024);
    expect(retained.endsWith("tail")).toBe(true);
  });
});
