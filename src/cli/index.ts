#!/usr/bin/env bun
import { Command } from "commander";
import { ZodError } from "zod";
import { ledgerDbPath } from "../lib/config.js";
import { DuplicateReleaseError, ReleaseLedger } from "../lib/ledger.js";
import { parsePackageSpec, recordRelease } from "../lib/record.js";
import { reconcileReleases } from "../lib/reconcile.js";
import { VERSION } from "../version.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(error: unknown): never {
  if (error instanceof ZodError) {
    printJson({ error: "invalid release document", issues: error.issues });
  } else {
    printJson({ error: error instanceof Error ? error.message : String(error) });
  }
  process.exit(1);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("releases")
  .description("Release ledger, publish receipts, downstream fan-out, and npm reconciliation for Hasna-coded apps")
  .version(VERSION)
  .option("--data-dir <path>", "Data directory (default ~/.hasna/releases, env RELEASES_DATA_DIR)");

program
  .command("record <spec>")
  .description("Record a publish receipt for <pkg>@<ver> in the release ledger")
  .requiredOption("--sha <gitSha>", "Git SHA the publish was cut from")
  .requiredOption("--path <path>", "Publish path: skill | ci")
  .option("--app <appId>", "App id slug (default: derived open-<name>)")
  .option("--published-at <iso>", "Publish timestamp (default: now)")
  .option("--evidence <uri>", "Evidence URI (repeatable)", collect, [])
  .option("--changelog-ref <uri>", "Changelog resource pointer URI")
  .option("--project <id>", "Todos project for fan-out tasks")
  .option("--no-fanout", "Skip creating downstream fan-out tasks")
  .action(async (spec: string, opts: {
    sha: string;
    path: string;
    app?: string;
    publishedAt?: string;
    evidence: string[];
    changelogRef?: string;
    project?: string;
    fanout: boolean;
  }) => {
    try {
      if (opts.path !== "skill" && opts.path !== "ci") {
        throw new Error('--path must be "skill" or "ci" ("backfilled" is reserved for releases reconcile)');
      }
      const { package: pkg, version } = parsePackageSpec(spec);
      const dataDir = program.opts<{ dataDir?: string }>().dataDir;
      const result = await recordRelease(
        {
          package: pkg,
          version,
          gitSha: opts.sha,
          publishPath: opts.path,
          appId: opts.app,
          publishedAt: opts.publishedAt,
          evidenceUris: opts.evidence,
          changelogRefUri: opts.changelogRef,
        },
        { dataDir, fanout: opts.fanout, fanoutProject: opts.project },
      );
      printJson({
        recorded: true,
        release: result.release,
        event: { id: result.event.id, type: result.event.type, subject: result.event.subject },
        fanout: result.fanout,
      });
    } catch (error) {
      if (error instanceof DuplicateReleaseError) {
        printJson({ recorded: false, error: error.message });
        process.exit(1);
      }
      fail(error);
    }
  });

program
  .command("status <pkg>")
  .description("Show the release ledger status for a package")
  .option("--limit <n>", "Max records to include", "20")
  .action((pkg: string, opts: { limit: string }) => {
    const ledger = new ReleaseLedger(ledgerDbPath(program.opts<{ dataDir?: string }>().dataDir));
    try {
      const records = ledger.listByPackage(pkg, Number.parseInt(opts.limit, 10) || 20);
      printJson({
        package: pkg,
        recorded_releases: ledger.count(pkg),
        latest: records[0] ?? null,
        records,
      });
    } finally {
      ledger.close();
    }
  });

program
  .command("list")
  .description("List recent release records across all packages")
  .option("--limit <n>", "Max records", "50")
  .action((opts: { limit: string }) => {
    const ledger = new ReleaseLedger(ledgerDbPath(program.opts<{ dataDir?: string }>().dataDir));
    try {
      const records = ledger.list(Number.parseInt(opts.limit, 10) || 50);
      printJson({ total: ledger.count(), records });
    } finally {
      ledger.close();
    }
  });

program
  .command("reconcile [packages...]")
  .description("Diff npm registry latest versions against the ledger and backfill/flag bypassing publishes")
  .option("--timeout <ms>", "npm view timeout per package", "20000")
  .action((packages: string[], opts: { timeout: string }) => {
    try {
      const report = reconcileReleases({
        packages: packages.length ? packages : undefined,
        dataDir: program.opts<{ dataDir?: string }>().dataDir,
        timeoutMs: Number.parseInt(opts.timeout, 10) || 20_000,
      });
      printJson(report);
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch(fail);
