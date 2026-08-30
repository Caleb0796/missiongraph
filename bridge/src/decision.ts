import type { Logger, Snapshot, SupervisorAction, SupervisorDecision } from "./types.js";

const maximumActions = 10;
const maximumTextBytes = 16 * 1024;

export const strictDecisionReminder = `FORMAT CORRECTION: Return exactly one unfenced JSON object and nothing else. The only top-level key is "actions". Example: {"actions":[]}`;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function action(value: unknown): SupervisorAction | undefined {
  if (!object(value) || typeof value.act !== "string") return undefined;
  if (value.act === "spawn_worker") {
    if (!exactKeys(value, ["act", "node_id", "brief"])) return undefined;
    if (typeof value.node_id !== "string" || typeof value.brief !== "string") return undefined;
    return { act: value.act, node_id: value.node_id, brief: value.brief };
  }
  if (["pause_worker", "resume_worker", "kill_worker"].includes(value.act)) {
    if (!exactKeys(value, ["act", "node_id"]) || typeof value.node_id !== "string") return undefined;
    return { act: value.act as "pause_worker" | "resume_worker" | "kill_worker", node_id: value.node_id };
  }
  if (value.act === "rebrief_worker") {
    if (!exactKeys(value, ["act", "node_id", "message"])) return undefined;
    if (typeof value.node_id !== "string" || typeof value.message !== "string") return undefined;
    return { act: value.act, node_id: value.node_id, message: value.message };
  }
  if (value.act === "note") {
    if (!exactKeys(value, ["act", "text"]) || typeof value.text !== "string") return undefined;
    return { act: value.act, text: value.text };
  }
  return undefined;
}

function agentMessages(jsonl: string): string[] {
  const messages: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "item.completed" && object(event.item)) {
        if (event.item.type === "agent_message" && typeof event.item.text === "string") {
          messages.push(event.item.text);
        }
      } else if (event.type === "agent_message" && typeof event.text === "string") {
        messages.push(event.text);
      }
    } catch {
      continue;
    }
  }
  return messages;
}

export function parseThreadId(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseSupervisorDecision(jsonl: string, logger: Logger): SupervisorDecision | undefined {
  const message = agentMessages(jsonl).at(-1);
  if (!message) {
    logger.warn("supervisor turn had no final agent_message");
    return undefined;
  }
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!object(parsed) || !exactKeys(parsed, ["actions"]) || !Array.isArray(parsed.actions)) throw new Error();
    const actions = parsed.actions.map(action);
    if (actions.some((candidate) => candidate === undefined)) throw new Error();
    return { actions: actions as SupervisorAction[] };
  } catch {
    logger.warn("supervisor final agent_message was not a valid SupervisorDecision");
    return undefined;
  }
}

export interface ValidatedDecision {
  decision: SupervisorDecision;
  journal: string[];
}

export function validateSupervisorDecision(
  decision: SupervisorDecision,
  snapshot: Snapshot,
): ValidatedDecision {
  const journal: string[] = [];
  const accepted: SupervisorAction[] = [];
  const spawned = new Set<string>();
  if (decision.actions.length > maximumActions) {
    journal.push(`Supervisor decision dropped ${decision.actions.length - maximumActions} actions beyond the per-turn cap of ${maximumActions}.`);
  }
  for (const candidate of decision.actions.slice(0, maximumActions)) {
    if (candidate.act !== "note" && !snapshot.state.nodes[candidate.node_id]) {
      journal.push(`Supervisor decision skipped ${candidate.act} for unknown node ${candidate.node_id}.`);
      continue;
    }
    if (candidate.act === "spawn_worker") {
      if (spawned.has(candidate.node_id)) {
        journal.push(`Supervisor decision skipped duplicate spawn_worker for node ${candidate.node_id} in one turn.`);
        continue;
      }
      spawned.add(candidate.node_id);
      if (Buffer.byteLength(candidate.brief) > maximumTextBytes) {
        journal.push(`Supervisor decision skipped spawn_worker for node ${candidate.node_id} because its brief exceeded 16 KB.`);
        continue;
      }
    }
    if (candidate.act === "rebrief_worker" && Buffer.byteLength(candidate.message) > maximumTextBytes) {
      journal.push(`Supervisor decision skipped rebrief_worker for node ${candidate.node_id} because its message exceeded 16 KB.`);
      continue;
    }
    accepted.push(candidate);
  }
  return { decision: { actions: accepted }, journal };
}
