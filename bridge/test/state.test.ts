import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { StateStore } from "../src/state.js";

describe("StateStore", () => {
  it("enforces one owner for a state file and releases the lock on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-lock-"));
    const path = join(root, "state.json");
    try {
      const first = await StateStore.open(path, "project");
      await expect(StateStore.open(path, "project")).rejects.toThrow(/held by live pid/);
      await first.close();
      const replacement = await StateStore.open(path, "project");
      await replacement.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up corrupt state, removes crash temporaries, and writes durable mode-0600 state", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-state-"));
    const path = join(root, "state.json");
    await writeFile(path, "{truncated");
    await writeFile(`${path}.123.tmp`, "temporary-secret", { mode: 0o600 });
    try {
      const state = await StateStore.open(path, "project");
      expect(state.state.cursor).toBe("0");
      expect(state.recoveryMessage).toContain("Recovered corrupt bridge state");
      expect((await readdir(root)).some((name) => name.startsWith("state.json.corrupt-"))).toBe(true);
      expect((await readdir(root))).not.toContain("state.json.123.tmp");
      await state.save();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        project_id: "project",
        cursor: "0",
        recovery_note: expect.stringContaining("Recovered corrupt bridge state"),
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await state.close();
      const reopened = await StateStore.open(path, "project");
      expect(reopened.recoveryMessage).toContain("Recovered corrupt bridge state");
      await reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
