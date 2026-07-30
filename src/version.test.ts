import { describe, expect, test } from "bun:test";

import pkg from "../package.json" with { type: "json" };
import { VERSION } from "./version.js";

/**
 * Regression guard for the version-skew class.
 *
 * `src/version.ts` is the constant behind `releases --version`
 * (src/cli/index.ts), the MCP server's advertised version
 * (src/mcp/server.ts) and the package's public `VERSION` export
 * (src/index.ts). None of those read package.json at runtime, so a
 * release that bumps package.json alone ships an artifact that
 * misreports itself — and the natural post-install check
 * (`releases --version`) then reads as a FAILED INSTALL.
 *
 * Caught in review on the 0.1.1 release: package.json had been bumped
 * to 0.1.1 while this constant still said 0.1.0. npm is immutable, so
 * that skew would have cost a whole 0.1.2 to correct. Nothing else in
 * the suite referenced VERSION, so the class was entirely unguarded.
 */
describe("version parity", () => {
  test("VERSION matches the package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  test("VERSION is a plain semver triple", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
