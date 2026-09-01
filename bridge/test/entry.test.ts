import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("../../deploy/entry.sh", import.meta.url));

describe("deploy entrypoint", () => {
  it("keeps post-clone Git configuration inside the bridge failure guard", async () => {
    execFileSync("sh", ["-n", entryPath]);
    const script = await readFile(entryPath, "utf8");

    expect(script).toMatch(
      /elif ! git -C \/data\/target-repo config user\.email "fleet@missiongraph\.local" \|\|\n\s+! git -C \/data\/target-repo config user\.name "MissionGraph Fleet"; then\n\s+echo "BRIDGE DISABLED: could not configure the cloned target repository" >&2\n\s+bridge_project_ready=0/,
    );
  });
});
