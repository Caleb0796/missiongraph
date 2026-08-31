import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { bridgePackageRoot, resolveBridgePackageRoot } from "../src/config.js";

describe("bridge package root", () => {
  it("resolves source and compiled module paths to the package root", () => {
    const expected = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const sourceUrl = pathToFileURL(join(expected, "src", "config.ts")).href;
    const compiledUrl = pathToFileURL(join(expected, "dist", "src", "config.js")).href;

    expect(bridgePackageRoot).toBe(expected);
    expect(resolveBridgePackageRoot(sourceUrl)).toBe(expected);
    expect(resolveBridgePackageRoot(compiledUrl)).toBe(expected);
  });
});
