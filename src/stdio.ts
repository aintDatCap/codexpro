#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createCodexProServer } from "./server.js";
import { createCodexProLogger } from "./logging.js";
import { RuntimeServices } from "./runtimeServices.js";
import { CODEXPRO_VERSION } from "./version.js";

function printHelp(): void {
  console.log(`CodexPro MCP stdio server

Usage:
  codexpro-mcp --root /path/to/repo [--allow-root /path]
  codexpro-mcp --version
  codexpro-mcp --help

Most users should run: codexpro start`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN ??= "1";
  const config = loadConfig();
  const rootLogger = createCodexProLogger({ workspaceRoot: config.defaultRoot, component: "stdio" });
  const runtime = new RuntimeServices(config, { logger: rootLogger });
  const logger = rootLogger.child({ transport: "stdio" });
  logger.info("runtime_start", { transport: "stdio", log_dir: logger.runDir });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logger.error("runtime_uncaught_exception", error, { origin });
  });

  const server = createCodexProServer(config, new Map<string, string>(), {
    runtime,
    logger
  });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.shutdown().catch(error => logger.error('runtime_shutdown_failed', error));
    await Promise.resolve((transport as any).close?.()).catch((error) => logger.error("mcp_transport_close_failed", error));
    process.exit(exitCode);
  };

  process.once("exit", (code) => logger.info("runtime_process_exit", { exit_code: code }));
  process.once("SIGINT", () => { void shutdown(130); });
  process.once("SIGTERM", () => { void shutdown(143); });
  try {
    await server.connect(transport);
    logger.info("mcp_transport_connected");
  } catch (error) {
    logger.error("runtime_failed", error);
    await runtime.shutdown().catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
