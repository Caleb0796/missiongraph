import { MissionGraphBridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import { consoleLogger } from "../src/types.js";

const config = await loadConfig();
const bridge = new MissionGraphBridge(
  config,
  consoleLogger,
  true,
  async (pid) => `sigterm-integration-${pid}`,
);
let resolveSignal!: () => void;
const signal = new Promise<void>((resolvePromise) => {
  resolveSignal = resolvePromise;
});
const stop = (): void => resolveSignal();
process.once("SIGTERM", stop);
try {
  await bridge.start();
  await signal;
  await bridge.stop();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
  await bridge.stop().catch(() => undefined);
} finally {
  process.removeListener("SIGTERM", stop);
}
