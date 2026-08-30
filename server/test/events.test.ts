import { describe, expect, it } from "vitest";

import { EventStore, eventTypes, parseEventInput } from "../src/events.js";
import { eventFixtures } from "./fixtures.js";

describe("event contract", () => {
  it("has a runtime-valid fixture for every event type", () => {
    expect(Object.keys(eventFixtures).sort()).toEqual([...eventTypes].sort());
    for (const fixture of Object.values(eventFixtures)) {
      expect(parseEventInput(fixture)).toEqual(fixture);
    }
  });

  it("returns the original sequence for an idempotent duplicate", () => {
    const store = new EventStore(":memory:");
    store.createProject("project", "token", "2026-08-30T10:00:00.000Z");
    const first = store.append("project", eventFixtures.TASK_ADDED, { ts: "2026-08-30T10:00:01.000Z" });
    const second = store.append("project", eventFixtures.TASK_ADDED, {
      baseSeq: 0,
      ts: "2026-08-30T10:00:02.000Z",
    });

    expect(first.event.seq).toBe(1);
    expect(second).toMatchObject({ duplicate: true, event: { seq: 1 } });
    expect(store.listEvents("project")).toHaveLength(1);
    store.close();
  });
});
