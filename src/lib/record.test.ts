import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAppId, parsePackageSpec, recordRelease } from "./record.js";
import { ReleaseLedger } from "./ledger.js";
import { ledgerDbPath } from "./config.js";
import type { CommandRunner } from "./fanout.js";

const outboxRunner: CommandRunner = () => ({
  status: null,
  stdout: "",
  stderr: "",
  error: { code: "ENOENT", message: "todos not found" },
});

describe("parsePackageSpec", () => {
  test("parses plain and scoped specs", () => {
    expect(parsePackageSpec("lodash@4.17.21")).toEqual({ package: "lodash", version: "4.17.21" });
    expect(parsePackageSpec("@hasna/todos@1.4.2")).toEqual({ package: "@hasna/todos", version: "1.4.2" });
  });

  test("rejects specs without a version", () => {
    expect(() => parsePackageSpec("@hasna/todos")).toThrow(/Invalid package spec/);
    expect(() => parsePackageSpec("lodash")).toThrow(/Invalid package spec/);
  });
});

describe("deriveAppId", () => {
  test("derives open-<name> slugs", () => {
    expect(deriveAppId("@hasna/todos")).toBe("open-todos");
    expect(deriveAppId("@hasna/open-todos")).toBe("open-todos");
    expect(deriveAppId("releases")).toBe("open-releases");
  });
});

describe("recordRelease", () => {
  test("validates, stores, emits release.published, and fans out", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "releases-record-"));
    const result = await recordRelease(
      {
        package: "@hasna/todos",
        version: "1.4.2",
        gitSha: "0f4c2d1",
        publishPath: "skill",
      },
      { dataDir, fanoutRunner: outboxRunner },
    );

    // ledger record is a valid hasna.release.v1 document
    expect(result.release.schema).toBe("hasna.release.v1");
    expect(result.release.appId).toBe("open-todos");
    expect(result.release.evidenceRefs.length).toBeGreaterThan(0);

    const ledger = new ReleaseLedger(ledgerDbPath(dataDir));
    expect(ledger.has("@hasna/todos", "1.4.2")).toBe(true);
    ledger.close();

    // typed event went through the open-events envelope into the local store
    expect(result.event.type).toBe("release.published");
    expect(result.event.source).toBe("releases");
    expect(result.event.data.appId).toBe("open-todos");
    expect(result.event.schemaVersion).toBeDefined();
    const eventsDir = join(dataDir, "events");
    const files = (readdirSync(eventsDir, { recursive: true }) as string[]).map(String);
    const stored = files
      .filter((file) => file.endsWith(".jsonl") || file.endsWith(".json"))
      .map((file) => readFileSync(join(eventsDir, file), "utf8"))
      .join("\n");
    expect(stored).toContain("release.published");

    // fan-out degraded to the outbox (todos CLI unavailable in this test)
    expect(result.fanout?.mode).toBe("outbox");
    expect(result.fanout?.dispatched).toHaveLength(4);
  });

  test("rejects invalid input before touching the ledger", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "releases-record-"));
    await expect(
      recordRelease(
        { package: "@hasna/todos", version: "not-semver", gitSha: "0f4c2d1", publishPath: "ci" },
        { dataDir, fanoutRunner: outboxRunner },
      ),
    ).rejects.toThrow();
    const ledger = new ReleaseLedger(ledgerDbPath(dataDir));
    expect(ledger.count()).toBe(0);
    ledger.close();
  });

  test("rejects duplicate records", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "releases-record-"));
    const input = { package: "@hasna/todos", version: "1.4.2", gitSha: "0f4c2d1", publishPath: "skill" as const };
    await recordRelease(input, { dataDir, fanoutRunner: outboxRunner });
    await expect(recordRelease(input, { dataDir, fanoutRunner: outboxRunner })).rejects.toThrow(/already recorded/);
  });
});
