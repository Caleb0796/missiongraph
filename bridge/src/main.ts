import { pathToFileURL } from "node:url";

import { MissionGraphBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { consoleLogger } from "./types.js";

export function argumentsFrom(argv: string[]): { dryRun: boolean; configPath?: string } {
  let dryRun = false;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--config") {
      configPath = argv[index + 1];
      if (!configPath) throw new Error("--config requires a path");
      index += 1;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return { dryRun, ...(configPath ? { configPath } : {}) };
}

async function main(): Promise<void> {
  const options = argumentsFrom(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const bridge = new MissionGraphBridge(config, consoleLogger, options.dryRun);
  let stopRequested = false;
  let shutdown: Promise<void> | undefined;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const stop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    shutdown = bridge.stop();
    void shutdown.then(resolveStop, resolveStop);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    try {
      await bridge.start();
    } catch (error) {
      if (stopRequested) return;
      throw error;
    }
    if (!stopRequested) {
      consoleLogger.info(`bridge running for project ${config.projectId}${options.dryRun ? " in dry-run mode" : ""}`);
    }
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (shutdown) await shutdown;
    else await bridge.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The daemon must outlive a failed supervisor/worker turn: durable state and the
  // action ledger make continuing safe, so stray async failures are logged, not fatal.
  process.on("unhandledRejection", (reason) => {
    consoleLogger.error(
      `unhandled rejection (daemon continues): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
  process.on("uncaughtException", (error) => {
    consoleLogger.error(`uncaught exception (daemon continues): ${error.stack ?? error.message}`);
  });
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
