import { describe, expect, it, vi } from "vitest";

import { ReporterClient, reporterPayload } from "../src/reporter.js";
import { workerBrief } from "../src/prompts.js";
import { config } from "./helpers.js";

describe("reporter contract", () => {
  it("builds exact fleet event envelopes", () => {
    expect(
      reporterPayload(
        "worker:node-a",
        "NODE_STATE_CHANGED",
        { node_id: "node-a", from: "queued", to: "running", detail: "Worker started" },
        "idem-1",
      ),
    ).toEqual({
      actor: "worker:node-a",
      type: "NODE_STATE_CHANGED",
      payload: { node_id: "node-a", from: "queued", to: "running", detail: "Worker started" },
      idem_key: "idem-1",
    });
    expect(
      reporterPayload(
        "worker:node-a",
        "HANDOFF_FILED",
        {
          node_id: "node-a",
          handoff: {
            v: 1,
            summary: "Implemented the requested task.",
            files: ["src/a.ts"],
            commits: ["abc123"],
            tests: "green",
            downstream_notes: "Import the new function.",
            deviations: [],
            artifacts: [],
          },
        },
        "idem-2",
      ),
    ).toMatchObject({
      actor: "worker:node-a",
      type: "HANDOFF_FILED",
      payload: { handoff: { v: 1, summary: "Implemented the requested task.", tests: "green" } },
      idem_key: "idem-2",
    });
  });

  it("makes lifecycle, log, handoff, and approval reporting non-optional in the worker brief", () => {
    const brief = workerBrief("node-a", "Build A.", "/tmp/repo");
    expect(brief).toContain("REPORTING IS REQUIRED AND NON-OPTIONAL");
    expect(brief).toContain('curl --config "$MG_REPORTER_CONFIG"');
    expect(brief).toContain("without exposing the credential in process arguments");
    expect(brief).toContain("NODE_STATE_CHANGED");
    expect(brief).toContain("WORKER_LOG");
    expect(brief).toContain("HANDOFF_FILED");
    expect(brief).toContain("APPROVAL_CREATED exactly once");
  });

  it("prefixes every dry-run journal write as simulated history", async () => {
    let body: { payload?: { text?: string } } = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return Response.json({ seq: 1 });
    }));
    try {
      const reporter = new ReporterClient(config("/tmp/missiongraph-dry-run"), true);
      await reporter.post(reporterPayload("supervisor", "JOURNAL_NOTE", { text: "Synthetic note." }));
      expect(body.payload?.text).toBe("DRY-RUN SIMULATION: Synthetic note.");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
