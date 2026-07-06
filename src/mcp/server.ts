import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import { registerReleasesMcpTools, type ReleasesMcpToolOptions } from "./tools.js";

export interface CreateReleasesMcpServerOptions extends ReleasesMcpToolOptions {
  name?: string;
  version?: string;
}

export function createReleasesMcpServer(options: CreateReleasesMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? "releases",
    version: options.version ?? VERSION,
  });
  registerReleasesMcpTools(server, { dataDir: options.dataDir });
  return server;
}
