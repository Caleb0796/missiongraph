#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FleetClient } from "./lib/client.mjs";
import { startFleetStub } from "./lib/stub.mjs";
import { scenarios } from "./scenarios.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const summaryPath = join(directory, "last-run.json");

function usage() {
  return "Usage: node eval/fleet/run.mjs --stub | --real SERVER_URL";
}

function parseMode(argv) {
  if (argv.length === 1 && argv[0] === "--stub") return { mode: "stub" };
  if (argv.length === 2 && argv[0] === "--real") {
    const url = new URL(argv[1]);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("SERVER_URL must use http or https");
    return { mode: "real", serverUrl: url.toString().replace(/\/$/, "") };
  }
  throw new Error(usage());
}

function printableError(error) {
  if (!(error instanceof Error)) return String(error);
  return error.message.replaceAll(process.env.REPORTER_TOKEN ?? "\0", "[redacted]");
}

function printTable(results) {
  const scenarioWidth = Math.max("SCENARIO".length, ...results.map((result) => result.name.length));
  const resultWidth = "RESULT".length;
  console.log(`${"SCENARIO".padEnd(scenarioWidth)}  ${"RESULT".padEnd(resultWidth)}  DURATION  DETAIL`);
  console.log(`${"-".repeat(scenarioWidth)}  ${"-".repeat(resultWidth)}  --------  ------`);
  for (const result of results) {
    console.log(
      `${result.name.padEnd(scenarioWidth)}  ${result.status.padEnd(resultWidth)}  ${String(result.duration_ms).padStart(6)}ms  ${result.error ?? ""}`,
    );
  }
}

async function main() {
  let selected;
  try {
    selected = parseMode(process.argv.slice(2));
  } catch (error) {
    console.error(printableError(error));
    process.exitCode = 2;
    return;
  }

  if (selected.mode === "real") {
    if (!process.env.SEED_PROJECT_ID) {
      console.error("SEED_PROJECT_ID is required in --real mode");
      process.exitCode = 2;
      return;
    }
    if (!process.env.REPORTER_TOKEN) {
      console.error("REPORTER_TOKEN is required in --real mode");
      process.exitCode = 2;
      return;
    }
  }

  const startedAt = new Date().toISOString();
  const results = [];
  let acceptedRequests = 0;
  const executionScenarios = selected.mode === "real"
    ? [...scenarios.filter((scenario) => scenario.name !== "daily-cap" && !scenario.disabled),
      scenarios.find((scenario) => scenario.name === "daily-cap"),
      ...scenarios.filter((scenario) => scenario.disabled)]
    : scenarios;
  for (const scenario of executionScenarios) {
    const started = Date.now();
    let controls;
    let client;
    let failure;
    if (selected.mode === "real" && scenario.stubOnly) {
      results.push({ name: scenario.name, status: "SKIP", duration_ms: 0, error: "stub mirror consistency scenario" });
      continue;
    }
    try {
      if (selected.mode === "stub") {
        controls = await startFleetStub(scenario.stubOptions);
        client = new FleetClient(controls.baseUrl, {
          reporterToken: controls.reporterToken,
          timeoutMs: Number(process.env.FLEET_EVAL_TIMEOUT_MS ?? 120_000),
        });
      } else {
        const baseUrl = scenario.disabled
          ? process.env.FLEET_DISABLED_SERVER_URL
          : selected.serverUrl;
        if (!baseUrl) {
          throw new Error("disabled-mode requires FLEET_DISABLED_SERVER_URL in --real mode");
        }
        client = new FleetClient(baseUrl, {
          reporterToken: process.env.REPORTER_TOKEN,
          timeoutMs: Number(process.env.FLEET_EVAL_TIMEOUT_MS ?? 120_000),
        });
      }
      await scenario.run({ client, controls, mode: selected.mode, acceptedBefore: acceptedRequests });
    } catch (error) {
      failure = error;
    } finally {
      try {
        await client?.assertCloneLedgersIsolated();
      } catch (error) {
        failure ??= error;
      }
      try {
        client?.assertAllResponsesSafe();
      } catch (error) {
        failure ??= error;
      }
      try {
        await controls?.close();
      } catch (error) {
        failure ??= error;
      }
    }
    results.push({
      name: scenario.name,
      status: failure ? "FAIL" : "PASS",
      duration_ms: Date.now() - started,
      ...(failure ? { error: printableError(failure) } : {}),
    });
    if (selected.mode === "real" && client) {
      acceptedRequests += client.fleetResponses.filter(
        (response) => response.path.endsWith("/fleet-requests") && response.status === 200,
      ).length;
    }
  }

  const passed = results.filter((result) => result.status === "PASS").length;
  const failed = results.filter((result) => result.status === "FAIL").length;
  const skipped = results.filter((result) => result.status === "SKIP").length;
  const summary = {
    version: 1,
    mode: selected.mode,
    ...(selected.mode === "real" ? { server_url: selected.serverUrl, seed_project_id: process.env.SEED_PROJECT_ID } : {}),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    passed,
    failed,
    skipped,
    total: results.length,
    scenarios: results,
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  printTable(results);
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`JSON summary: ${summaryPath}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
