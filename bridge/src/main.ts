import { MissionGraphBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { consoleLogger } from "./types.js";

function argumentsFrom(argv: string[]): { dryRun: boolean; configPath?: string } {
  let dryRun = false;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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
  await bridge.start();
  consoleLogger.info(`bridge running for project ${config.projectId}${options.dryRun ? " in dry-run mode" : ""}`);
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => resolvePromise();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await bridge.stop();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
