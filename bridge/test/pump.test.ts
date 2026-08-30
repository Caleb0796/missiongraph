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
});
