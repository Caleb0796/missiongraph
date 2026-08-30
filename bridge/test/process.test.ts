import { describe, expect, it, vi } from "vitest";

import { terminateProcess } from "../src/process.js";

describe("process identity", () => {
  it("does not signal a reused pid whose start time does not match", async () => {
    const signal = vi.fn();
    await expect(terminateProcess(
      { pid: 42, starttime: "original" },
      { lookup: async () => "replacement", signal },
    )).resolves.toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });
});
