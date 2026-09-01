import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { StateStore } from "../src/state.js";

const processStartTime = async (pid: number): Promise<string | undefined> => pid === process.pid ? "test-start" : undefined;

describe("StateStore", () => {
  it("enforces one owner for a state file and releases the lock on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-lock-"));
    const path = join(root, "state.json");
    try {
      const first = await StateStore.open(path, "project", processStartTime);
      await expect(StateStore.open(path, "project", processStartTime)).rejects.toThrow(/held by live pid/);
      await first.close();
      const replacement = await StateStore.open(path, "project", processStartTime);
      await replacement.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes the held lock lease and stops its heartbeat on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-lock-heartbeat-"));
    const path = join(root, "state.json");
    const lockPath = `${path}.lock`;
    let state: StateStore | undefined;
    try {
      state = await StateStore.open(path, "project", processStartTime, 20);
      const lockContents = await readFile(lockPath, "utf8");
      const stale = new Date(Date.now() - 10 * 60_000);
      await utimes(lockPath, stale, stale);
      const deadline = Date.now() + 1_000;
      while ((await stat(lockPath)).mtimeMs === stale.getTime() && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(stale.getTime());

      await state.close();
      state = undefined;
      await writeFile(lockPath, lockContents);
      await utimes(lockPath, stale, stale);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
      expect((await stat(lockPath)).mtimeMs).toBe(stale.getTime());
    } finally {
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent contender to take over a stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-stale-lock-"));
    const path = join(root, "state.json");
    await writeFile(`${path}.lock`, JSON.stringify({
      pid: process.pid,
      starttime: "reused-old-start",
      hostname: hostname(),
      owner_id: "stale-owner",
    }));
    let winner: StateStore | undefined;
    try {
      const contenders = await Promise.allSettled([
        StateStore.open(path, "project", processStartTime),
        StateStore.open(path, "project", processStartTime),
      ]);
      const fulfilled = contenders.filter((result): result is PromiseFulfilledResult<StateStore> => result.status === "fulfilled");
      const rejected = contenders.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toMatch(/takeover in progress|held by live pid|changed during stale-lock takeover/);
      winner = fulfilled[0]?.value;
    } finally {
      await winner?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an orphaned takeover claim and retries lock recovery once", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-orphan-takeover-"));
    const path = join(root, "state.json");
    await writeFile(`${path}.lock`, JSON.stringify({
      pid: 41_001,
      starttime: "stale-lock-start",
      hostname: hostname(),
      owner_id: "stale-lock-owner",
    }));
    await writeFile(`${path}.lock.takeover`, JSON.stringify({
      pid: 41_002,
      starttime: "orphan-takeover-start",
      hostname: hostname(),
      owner_id: "orphan-takeover-owner",
    }));
    let state: StateStore | undefined;
    try {
      state = await StateStore.open(path, "project", processStartTime);
      expect(await readFile(`${path}.lock`, "utf8")).toContain(`"pid":${process.pid}`);
      await expect(readFile(`${path}.lock.takeover`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up corrupt state, removes crash temporaries, and writes durable mode-0600 state", async () => {
    const root = await mkdtemp(join(tmpdir(), "missiongraph-state-"));
    const path = join(root, "state.json");
    await writeFile(path, "{truncated");
    await writeFile(`${path}.123.tmp`, "temporary-secret", { mode: 0o600 });
    try {
      const state = await StateStore.open(path, "project", processStartTime);
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
      const reopened = await StateStore.open(path, "project", processStartTime);
      expect(reopened.recoveryMessage).toContain("Recovered corrupt bridge state");
      await reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
