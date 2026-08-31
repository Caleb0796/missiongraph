import { describe, expect, it } from "vitest";

import { assertDryRunState } from "../src/bridge.js";
import { argumentsFrom } from "../src/main.js";

describe("bridge launcher arguments", () => {
  it("accepts the pnpm separator before dry-run", () => {
    expect(argumentsFrom(["--", "--dry-run"])).toEqual({ dryRun: true });
  });

  it.each(["spawning", "live", "idle", "dead"] as const)("refuses dry-run state that contains a %s worker", (status) => {
    expect(() => assertDryRunState("/tmp/persistent-state.json", {
      v: 1,
      project_id: "project",
      cursor: "0",
      pending_actions: [],
      dead_letters: [],
      workers: {
        a: { status, thread_id: "worker-a", worktree: "/tmp/a", branch: "work/a" },
      },
    })).toThrow(/--dry-run refuses bridge state \/tmp\/persistent-state\.json/);
  });

  it("refuses dry-run state that records a supervisor process", () => {
    expect(() => assertDryRunState("/tmp/persistent-state.json", {
      v: 1,
      project_id: "project",
      cursor: "0",
      supervisor_pid: 12_345,
      pending_actions: [],
      dead_letters: [],
      workers: {},
    })).toThrow(/--dry-run refuses bridge state \/tmp\/persistent-state\.json/);
  });
});
