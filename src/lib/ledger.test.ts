import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DuplicateReleaseError, ReleaseLedger } from "./ledger.js";
import type { Release } from "../vendor/contracts.js";

function memoryLedger(): ReleaseLedger {
  return new ReleaseLedger(new Database(":memory:"));
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    schema: "hasna.release.v1",
    id: `rel-${Math.random().toString(36).slice(2)}`,
    createdAt: "2026-07-06T10:00:00.000Z",
    appId: "open-todos",
    package: "@hasna/todos",
    version: "1.4.2",
    gitSha: "0f4c2d1",
    publishedAt: "2026-07-06T10:00:00.000Z",
    publishPath: "skill",
    evidenceRefs: [{ id: "evd-1", uri: "https://example.com/log" }],
    ...overrides,
  } as Release;
}

describe("ReleaseLedger", () => {
  test("insert + listByPackage + latestFor round trip", () => {
    const ledger = memoryLedger();
    ledger.insert(release({ version: "1.4.2", publishedAt: "2026-07-06T10:00:00.000Z" }));
    ledger.insert(release({ version: "1.4.3", publishedAt: "2026-07-06T11:00:00.000Z" }));
    expect(ledger.count("@hasna/todos")).toBe(2);
    expect(ledger.latestFor("@hasna/todos")?.version).toBe("1.4.3");
    expect(ledger.listByPackage("@hasna/todos").map((r) => r.version)).toEqual(["1.4.3", "1.4.2"]);
    ledger.close();
  });

  test("rejects duplicate package@version", () => {
    const ledger = memoryLedger();
    ledger.insert(release());
    expect(() => ledger.insert(release())).toThrow(DuplicateReleaseError);
    ledger.close();
  });

  test("rejects invalid documents on insert", () => {
    const ledger = memoryLedger();
    expect(() => ledger.insert(release({ gitSha: "not-a-sha" } as Partial<Release>))).toThrow();
    ledger.close();
  });

  test("listPackages returns distinct packages", () => {
    const ledger = memoryLedger();
    ledger.insert(release());
    ledger.insert(release({ package: "@hasna/events", appId: "open-events", version: "0.1.13" }));
    expect(ledger.listPackages()).toEqual(["@hasna/events", "@hasna/todos"]);
    ledger.close();
  });
});
