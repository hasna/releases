import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read the registry auth token from `.npmrc` so restricted scopes resolve.
 *
 * The value is returned for use as an Authorization header and must never be
 * printed, logged, echoed or written to a report. Callers pass it straight into
 * a request header and nowhere else.
 */
export function readNpmrcToken(path = join(homedir(), ".npmrc")): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of contents.split("\n")) {
    const match = /^\s*\/\/[^:]+:_authToken\s*=\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      const value = match[1].replace(/^["']|["']$/g, "");
      // Expand `${VAR}` indirection rather than returning the literal.
      const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
      if (expanded.length > 0) return expanded;
    }
  }
  return undefined;
}
