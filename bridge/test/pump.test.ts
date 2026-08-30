import { describe, expect, it } from "vitest";

import { EnvelopePump } from "../src/pump.js";
import { event, TestLogger } from "./helpers.js";

describe("EnvelopePump", () => {
  it("keeps FIFO order and allows only one delivery in flight", async () => {
    const logger = new TestLogger();
    const delivered: number[][] = [];
    const cursors: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolvePromise) => {
      markFirstStarted = resolvePromise;
    });
    const pump = new EnvelopePump(
      async (events) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        delivered.push(events.map((item) => item.seq));
        if (events[0]?.seq === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        active -= 1;
        return { afterCommit: async () => undefined };
      },
      async (cursor) => {
        cursors.push(cursor);
      },
      logger,
    );

    pump.enqueue(event(1));
    await firstStarted;
    pump.enqueue(event(2));
    pump.enqueue(event(3));
    await Promise.resolve();
    expect(delivered).toEqual([[1]]);

    releaseFirst();
    await pump.whenIdle();
    expect(delivered).toEqual([[1], [2, 3]]);
    expect(cursors).toEqual(["1", "3"]);
    expect(maximumActive).toBe(1);
  });

  it("advances past non-structural events without delivering them", async () => {
    const delivered: number[][] = [];
    const cursors: string[] = [];
    const pump = new EnvelopePump(
      async (events) => {
        delivered.push(events.map((item) => item.seq));
        return { afterCommit: async () => undefined };
      },
      async (cursor) => {
        cursors.push(cursor);
      },
      new TestLogger(),
    );
    pump.enqueue(event(1, "WORKER_LOG", { node_id: "a", lines: ["tail"] }));
    await pump.whenIdle();
    expect(delivered).toEqual([]);
    expect(cursors).toEqual(["1"]);
  });

  it("persists the cursor before executing prepared actions", async () => {
    const order: string[] = [];
    const pump = new EnvelopePump(
      async () => {
        order.push("resume-and-parse");
        return { afterCommit: async () => { order.push("actions"); } };
      },
      async () => { order.push("cursor"); },
      new TestLogger(),
    );
    pump.enqueue(event(1));
    await pump.whenIdle();
    expect(order).toEqual(["resume-and-parse", "cursor", "actions"]);
  });

  it("retries supervisor delivery after a cursor save failure without executing actions early", async () => {
    let preparations = 0;
    let commits = 0;
    let actions = 0;
    const pump = new EnvelopePump(
      async () => {
        preparations += 1;
        return { afterCommit: async () => { actions += 1; } };
      },
      async () => {
        commits += 1;
        if (commits === 1) throw new Error("disk unavailable");
      },
      new TestLogger(),
    );
    pump.enqueue(event(1));
    await pump.whenIdle();
    expect(preparations).toBe(2);
    expect(commits).toBe(2);
    expect(actions).toBe(1);
  });

  it("caps queued envelopes and reports WORKER_LOG drops once per flood", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const firstStarted = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    const delivered: number[][] = [];
    const cursors: string[] = [];
    const drops: number[] = [];
    const pump = new EnvelopePump(
      async (events) => {
        delivered.push(events.map((item) => item.seq));
        if (events[0]?.seq === 1) {
          started();
          await blocked;
        }
        return { afterCommit: async () => undefined };
      },
      async (cursor) => { cursors.push(cursor); },
      new TestLogger(),
      async (count) => { drops.push(count); },
      3,
    );

    pump.enqueue(event(1));
    await firstStarted;
    pump.enqueue(event(2, "WORKER_LOG"));
    pump.enqueue(event(3, "WORKER_LOG"));
    pump.enqueue(event(4, "WORKER_LOG"));
    pump.enqueue(event(5));
    pump.enqueue(event(6, "WORKER_LOG"));
    release();
    await pump.whenIdle();

    expect(delivered).toEqual([[1], [5]]);
    expect(cursors).toEqual(["1", "6"]);
    expect(drops).toEqual([2]);
  });
});
