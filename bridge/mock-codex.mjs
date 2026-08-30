#!/usr/bin/env node

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const agent = (value) => emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } });

if (args[0] !== "exec") process.exit(2);

if (args[1] === "resume") {
  const threadId = args[2];
  const message = args[3] ?? "";
  emit({ type: "thread.started", thread_id: threadId });
  if (threadId === "mock-supervisor") {
    let envelopes = [];
    try {
      const parsed = JSON.parse(message);
      envelopes = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      envelopes = [];
    }
    const actions = envelopes
      .filter((envelope) => envelope?.type === "DISPATCHED" && typeof envelope.node_id === "string")
      .map((envelope) => ({
        act: "spawn_worker",
        node_id: envelope.node_id,
        brief: typeof envelope.brief_override === "string" ? envelope.brief_override : `Execute node ${envelope.node_id}.`,
      }));
    agent({ actions });
  } else {
    agent({ worker_ack: true });
  }
  process.exit(0);
}

const brief = args[1] ?? "";
if (brief.startsWith("MISSIONGRAPH SUPERVISOR")) {
  emit({ type: "thread.started", thread_id: "mock-supervisor" });
  agent({ actions: [] });
} else {
  const nodeId = brief.match(/Node ID: ([^\n]+)/)?.[1] ?? createHash("sha1").update(brief).digest("hex").slice(0, 8);
  emit({ type: "thread.started", thread_id: `mock-worker-${nodeId}` });
  agent({ worker_complete: true });
}
