import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DATA_DIR = join(homedir(), ".hasna", "releases");

export function resolveDataDir(dataDir?: string): string {
  const fromEnv = process.env["RELEASES_DATA_DIR"];
  const resolved = dataDir?.trim() || (fromEnv?.trim() ? fromEnv : DEFAULT_DATA_DIR);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function ledgerDbPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "releases.db");
}

export function outboxPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "outbox.jsonl");
}

export function eventsDataDir(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "events");
}
