import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ReleaseLedger } from "./ledger.js";
import { reconcileReleases } from "./reconcile.js";
import type { CommandRunner } from "./fanout.js";
import type { Release } from "../vendor/contracts.js";

function seededLedger(): ReleaseLedger {
  const ledger = new ReleaseLedger(new Database(":memory:"));
  const base: Release = {
    schema: "hasna.release.v1",
    id: "rel-seed-1",
    createdAt: "2026-07-06T10:00:00.000Z",
    appId: "open-todos",
    package: "@hasna/todos",
    version: "1.4.2",
    gitSha: "0f4c2d1",
    publishedAt: "2026-07-06T10:00:00.000Z",
    publishPath: "skill",
    evidenceRefs: [{ id: "evd-1", uri: "https://example.com/log" }],
  };
  ledger.insert(base);
  return ledger;
}

function npmRunner(responses: Record<string, { status: number; stdout?: string; stderr?: string; enoent?: boolean }>): CommandRunner {
  return (_command, args) => {
    const pkg = args[1]!;
    const response = responses[pkg];
    if (!response) return { status: 1, stdout: "", stderr: `E404 '${pkg}' is not in this registry` };
    if (response.enoent) return { status: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "npm not found" } };
    return { status: response.status, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
}

describe("reconcileReleases", () => {
  test("reports in_sync when npm latest matches a ledger record", () => {
    const ledger = seededLedger();
    const report = reconcileReleases({
      ledger,
      runner: npmRunner({
        "@hasna/todos": { status: 0, stdout: JSON.stringify({ version: "1.4.2", gitHead: "0f4c2d1" }) },
      }),
    });
    expect(report.summary).toMatchObject({ packages: 1, in_sync: 1, backfilled: 0 });
    ledger.close();
  });

  test("backfills and flags npm versions missing from the ledger", () => {
    const ledger = seededLedger();
    const report = reconcileReleases({
      ledger,
      runner: npmRunner({
        "@hasna/todos": { status: 0, stdout: JSON.stringify({ version: "1.5.0", gitHead: "aa11bb22cc" }) },
      }),
    });
    const entry = report.entries[0]!;
    expect(entry.status).toBe("backfilled");
    expect(entry.flagged).toBe(true);
    const backfilled = ledger.latestFor("@hasna/todos")!;
    expect(backfilled.version).toBe("1.5.0");
    expect(backfilled.publishPath).toBe("backfilled");
    expect(backfilled.gitSha).toBe("aa11bb22cc");
    expect(backfilled.appId).toBe("open-todos");
    expect(backfilled.metadata?.["flagged"]).toBe("publish-bypassed-ledger");
    ledger.close();
  });

  test("uses a placeholder sha when the registry has no gitHead", () => {
    const ledger = seededLedger();
    reconcileReleases({
      ledger,
      runner: npmRunner({ "@hasna/todos": { status: 0, stdout: JSON.stringify({ version: "1.5.0" }) } }),
    });
    const backfilled = ledger.latestFor("@hasna/todos")!;
    expect(backfilled.gitSha).toBe("0000000");
    expect(backfilled.metadata?.["gitShaPlaceholder"]).toBe(true);
    ledger.close();
  });

  test("handles a single-string npm view response shape", () => {
    const ledger = seededLedger();
    const report = reconcileReleases({
      ledger,
      runner: npmRunner({ "@hasna/todos": { status: 0, stdout: JSON.stringify("1.4.2") } }),
    });
    expect(report.entries[0]?.status).toBe("in_sync");
    ledger.close();
  });

  test("degrades gracefully when the registry is unreachable (offline)", () => {
    const ledger = seededLedger();
    const report = reconcileReleases({
      ledger,
      runner: () => ({ status: 1, stdout: "", stderr: "ETIMEDOUT registry.npmjs.org" }),
    });
    expect(report.entries[0]?.status).toBe("registry_unreachable");
    expect(report.summary.unreachable).toBe(1);
    expect(ledger.count()).toBe(1);
    ledger.close();
  });

  test("reports not_on_registry for 404 packages", () => {
    const ledger = seededLedger();
    const report = reconcileReleases({ ledger, runner: npmRunner({}) });
    expect(report.entries[0]?.status).toBe("not_on_registry");
    ledger.close();
  });

  test("reconciles an explicit package list", () => {
    const ledger = seededLedger();
    const report = reconcileReleases({
      ledger,
      packages: ["@hasna/events"],
      runner: npmRunner({
        "@hasna/events": { status: 0, stdout: JSON.stringify({ version: "0.1.13", gitHead: "beef1234" }) },
      }),
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ package: "@hasna/events", status: "backfilled", flagged: true });
    expect(ledger.latestFor("@hasna/events")?.appId).toBe("open-events");
    ledger.close();
  });
});
