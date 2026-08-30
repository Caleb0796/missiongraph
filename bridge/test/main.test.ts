import { describe, expect, it } from "vitest";

import { argumentsFrom } from "../src/main.js";

describe("bridge launcher arguments", () => {
  it("accepts the pnpm separator before dry-run", () => {
    expect(argumentsFrom(["--", "--dry-run"])).toEqual({ dryRun: true });
  });
});
