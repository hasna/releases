#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createReleasesMcpServer } from "./server.js";

export { registerReleasesMcpTools } from "./tools.js";
export type { ReleasesMcpToolOptions } from "./tools.js";
export { createReleasesMcpServer } from "./server.js";
export type { CreateReleasesMcpServerOptions } from "./server.js";

export async function startMcpServer(): Promise<void> {
  const server = createReleasesMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function printHelp(): void {
  console.log(`Usage: releases-mcp [options]

Open Releases MCP server over stdio.

Tools:
  releases_record
  releases_status
  releases_list
  releases_reconcile

Options:
  -h, --help  Display help`);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  await startMcpServer();
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/mcp/index.ts") ||
  process.argv[1]?.endsWith("/mcp/index.js");

if (isDirectRun) {
  main().catch((error) => {
    console.error("MCP server error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
