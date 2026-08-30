import { describe, expect, it } from "vitest";

import { assertDryRunState } from "../src/bridge.js";
import { argumentsFrom } from "../src/main.js";

describe("bridge launcher arguments", () => {
  it("accepts the pnpm separator before dry-run", () => {
    expect(argumentsFrom(["--", "--dry-run"])).toEqual({ dryRun: true });
  });

  it("refuses dry-run state that contains resumable workers", () => {
    expect(() => assertDryRunState("/tmp/persistent-state.json", {
      v: 1,
      project_id: "project",
      cursor: "0",
      pending_actions: [],
      workers: {
        a: { status: "idle", thread_id: "worker-a", worktree: "/tmp/a", branch: "work/a" },
      },
    })).toThrow(/--dry-run refuses bridge state \/tmp\/persistent-state\.json/);
  });
});
