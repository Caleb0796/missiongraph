#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const agent = (value) => emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } });
const includesPair = (flag, value) => args.some((argument, index) => argument === flag && args[index + 1] === value);
const finish = async () => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
};

async function report(type, payload) {
  const url = process.env.MG_REPORT_URL;
  const config = process.env.MG_REPORTER_CONFIG;
  const actor = process.env.MG_WORKER_ACTOR;
  if (!url || !config || !actor) throw new Error("mock lifecycle reporting environment is incomplete");
  const body = JSON.stringify({ actor, type, payload, idem_key: randomUUID() });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "curl",
      [
        "--config",
        config,
        "--fail",
        "--silent",
        "--show-error",
        "-X",
        "POST",
        url,
        "-H",
        "content-type: application/json",
        "--data-binary",
        "@-",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`mock lifecycle report ${type} failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(body);
  });
}

for (const name of ["REPORTER_TOKEN", "MG_REPORTER_CREDENTIAL", "MG_VISITOR_TOKEN"]) {
  if (process.env[name] !== undefined) {
    process.stderr.write(`forbidden inherited environment variable: ${name}\n`);
    process.exit(3);
  }
}

if (args[0] !== "exec") process.exit(2);

if (args[1] === "resume") {
  const threadId = args[2];
  const message = args[3] ?? "";
  const supervisor = threadId?.startsWith("mock-supervisor");
  if (args.includes("-s")) process.exit(9);
  if (!includesPair("-c", supervisor ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"')) process.exit(4);
  if (supervisor && args.includes("sandbox_workspace_write.network_access=true")) process.exit(5);
  if (!supervisor && !args.includes("sandbox_workspace_write.network_access=true")) process.exit(6);
  emit({ type: "thread.started", thread_id: threadId });
  if (supervisor) {
    if (threadId === "mock-supervisor-malformed" || message.startsWith("FORMAT CORRECTION:")) {
      emit({ type: "item.completed", item: { type: "agent_message", text: "not-json" } });
      await finish();
      process.exit(0);
    }
    let envelopes = [];
    try {
      const parsed = JSON.parse(message);
      envelopes = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      envelopes = [];
    }
    let malformed = false;
    const actions = envelopes.flatMap((envelope) => {
      if (envelope?.type === "ANNOTATED" && envelope.note === "MALFORMED_DECISION_TEST") {
        malformed = true;
        return [];
      }
      if (envelope?.type === "DISPATCHED" && typeof envelope.node_id === "string") {
        return [{
          act: "spawn_worker",
          node_id: envelope.node_id,
          brief: typeof envelope.brief_override === "string" ? envelope.brief_override : `Execute node ${envelope.node_id}.`,
        }];
      }
      if (envelope?.type === "ANNOTATED") {
        return [{ act: "note", text: `Supervisor observed annotation for ${String(envelope.target_id)}.` }];
      }
      return [];
    });
    if (malformed) emit({ type: "item.completed", item: { type: "agent_message", text: "not-json" } });
    else agent({ actions });
  } else {
    agent({ worker_ack: true });
  }
  await finish();
  process.exit(0);
}

const brief = args[1] ?? "";
if (brief.startsWith("MISSIONGRAPH SUPERVISOR")) {
  if (!includesPair("-s", "read-only") || args.includes("sandbox_workspace_write.network_access=true")) process.exit(7);
  emit({ type: "thread.started", thread_id: "mock-supervisor" });
  agent({ actions: [] });
} else {
  if (!includesPair("-s", "workspace-write") || !args.includes("sandbox_workspace_write.network_access=true")) process.exit(8);
  // The prompt now carries the node ID as a single-line JSON string, so decode it the way a
  // real prompt consumer would before treating it as an identifier.
  const nodeIdField = brief.match(/Node ID: ([^\n]+)/)?.[1];
  let nodeId = nodeIdField ?? createHash("sha1").update(brief).digest("hex").slice(0, 8);
  try {
    const parsed = JSON.parse(nodeId);
    if (typeof parsed === "string") nodeId = parsed;
  } catch {}
  const reportLifecycle = brief.includes("MOCK_REPORT_LIFECYCLE");
  if (brief.includes("MOCK_NO_THREAD")) await new Promise(() => setInterval(() => undefined, 1_000));
  emit({ type: "thread.started", thread_id: `mock-worker-${nodeId}` });
  if (reportLifecycle) {
    await report("NODE_STATE_CHANGED", { node_id: nodeId, from: "queued", to: "running", detail: "Mock fleet worker started." });
    await report("WORKER_LOG", { node_id: nodeId, lines: ["Mock fleet worker is running."] });
  }
  agent({ worker_complete: true });
  const delay = Number(brief.match(/MOCK_DELAY_(\d+)/)?.[1] ?? "0");
  if (brief.includes("MOCK_HANG")) await new Promise(() => setInterval(() => undefined, 1_000));
  if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  if (brief.includes("MOCK_FAIL")) process.exit(12);
  if (reportLifecycle) {
    await report("WORKER_LOG", { node_id: nodeId, lines: ["Mock fleet worker finished."] });
    await report("NODE_STATE_CHANGED", { node_id: nodeId, from: "running", to: "review", detail: "Mock fleet worker finished." });
    await report("HANDOFF_FILED", {
      node_id: nodeId,
      handoff: {
        v: 1,
        summary: "Mock fleet worker completed the seeded integration task.",
        files: [],
        commits: [],
        tests: "green",
        downstream_notes: "No downstream action required.",
        deviations: [],
        artifacts: [],
      },
    });
    if (!brief.includes("MOCK_PARTIAL_PROTOCOL")) {
      await report("APPROVAL_CREATED", {
        approval_id: `mock-fleet-approval-${randomUUID()}`,
        node_id: nodeId,
        summary: "Review the mock fleet worker handoff.",
        tests: "green",
      });
    }
  }
}
await finish();
