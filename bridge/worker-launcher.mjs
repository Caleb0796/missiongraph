#!/usr/bin/env node

import { spawn } from "node:child_process";

const [executable, ...args] = process.argv.slice(2);
if (!executable) process.exit(2);

let child;
let started = false;
let terminating = false;

function terminate(signal = "SIGTERM") {
  if (terminating) return;
  terminating = true;
  if (!child) {
    process.exit(0);
    return;
  }
  child.kill(signal);
  const timer = setTimeout(() => child?.kill("SIGKILL"), 5_000);
  timer.unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => terminate(signal));
}

process.stdin.setEncoding("utf8");
process.stdin.once("data", (value) => {
  if (value.trim() !== "start" || started) process.exit(3);
  started = true;
  child = spawn(executable, args, {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    process.exit(signal ? 1 : code ?? 1);
  });
});
process.stdin.once("end", () => {
  if (!started) process.exit(0);
});
