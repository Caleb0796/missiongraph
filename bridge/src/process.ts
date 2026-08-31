import { spawn } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  starttime: string;
}

export type ProcessStartTimeLookup = (pid: number) => Promise<string | undefined>;

export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return new Promise<string | undefined>((resolvePromise, rejectPromise) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "lstart="], {
      env: process.env.PATH ? { PATH: process.env.PATH } : undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-1024);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1024);
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim().replace(/\s+/g, " ") || undefined);
      else if (code === 1) resolvePromise(undefined);
      else rejectPromise(new Error(`ps failed (${code}): ${stderr.trim()}`));
    });
  });
}

export async function identifyProcess(
  pid: number,
  lookup: ProcessStartTimeLookup = readProcessStartTime,
): Promise<ProcessIdentity> {
  const starttime = await lookup(pid);
  if (!starttime) throw new Error(`could not identify process ${pid}`);
  return { pid, starttime };
}

export async function processMatches(
  identity: ProcessIdentity,
  lookup: ProcessStartTimeLookup = readProcessStartTime,
): Promise<boolean> {
  return await lookup(identity.pid) === identity.starttime;
}

interface TerminationControl {
  lookup: ProcessStartTimeLookup;
  signal(pid: number, signal: NodeJS.Signals): void;
  wait(delayMs: number): Promise<void>;
  now(): number;
}

const defaultTerminationControl: TerminationControl = {
  lookup: readProcessStartTime,
  signal: (pid, signal) => process.kill(pid, signal),
  wait: (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  now: Date.now,
};

export async function terminateProcess(
  identity: ProcessIdentity,
  control: Partial<TerminationControl> = {},
): Promise<boolean> {
  const current = { ...defaultTerminationControl, ...control };
  if (!await processMatches(identity, current.lookup)) return false;
  current.signal(identity.pid, "SIGTERM");
  const deadline = current.now() + 10_000;
  while (current.now() < deadline) {
    if (!await processMatches(identity, current.lookup)) return true;
    await current.wait(50);
  }
  if (await processMatches(identity, current.lookup)) current.signal(identity.pid, "SIGKILL");
  return true;
}
