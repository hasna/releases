#!/usr/bin/env bun
import { Command } from "commander";
import { ZodError } from "zod";
import { ledgerDbPath } from "../lib/config.js";
import { DuplicateReleaseError, ReleaseLedger } from "../lib/ledger.js";
import { parsePackageSpec, recordRelease } from "../lib/record.js";
import { reconcileReleases } from "../lib/reconcile.js";
import { renderTable, runShipGap } from "../lib/shipgap-run.js";
import { shouldFailGate } from "../lib/shipgap.js";
import { runPublishGates } from "../lib/publish-gate-run.js";
import { readNpmrcToken } from "../lib/npmrc.js";
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

program
  .command("shipgap")
  .description(
    "Detect the gaps between merged, published and installed: branch package.json vs npm registry vs every fleet machine",
  )
  .option("--org <org>", "Org to scan (repeatable; default hasna and hasnaxyz)", collect, [])
  .option("--scope <scope>", "Package-name scope to consider (repeatable; default @hasna/ and @hasnaxyz/)", collect, [])
  .option("--only <org/repo>", "Restrict to specific repos (repeatable)", collect, [])
  .option("--as-of <iso>", "Replay the detector against history at this instant")
  .option("--skip-fleet", "Metadata-only run; do not probe machines")
  .option("--ssm-profile <profile>", "AWS profile owning SSM-managed stations", "hasna-stations")
  .option("--local-machine <id>", "Manifest id of the machine this runs on (probed without a network hop)")
  .option("--concurrency <n>", "Parallel repo lookups", "8")
  .option("--json", "Emit the full JSON report instead of a table")
  .option("--fail-on-gap", "Exit non-zero when any merged-but-unshipped package is found, OR when any axis could not be measured")
  .action(async (opts: {
    org: string[];
    scope: string[];
    only: string[];
    asOf?: string;
    skipFleet?: boolean;
    ssmProfile: string;
    localMachine?: string;
    concurrency: string;
    json?: boolean;
    failOnGap?: boolean;
  }) => {
    try {
      // Read only; never printed, never logged. Restricted scopes 404 without a
      // credential that can see them, and $NPM_TOKEN is not necessarily the same
      // token as ~/.npmrc, so both are offered and the first that works wins.
      const npmrcToken = readNpmrcToken();
      const envToken = process.env.NPM_TOKEN;
      const registryToken = npmrcToken ?? envToken;
      const registryFallbackTokens = [envToken, npmrcToken].filter(
        (token): token is string => Boolean(token) && token !== registryToken,
      );
      const report = await runShipGap({
        ...(opts.org.length ? { orgs: opts.org } : {}),
        ...(opts.scope.length ? { scopes: opts.scope } : {}),
        ...(opts.only.length ? { only: opts.only } : {}),
        ...(opts.asOf ? { asOf: opts.asOf } : {}),
        ...(opts.skipFleet ? { skipFleet: true } : {}),
        ...(opts.localMachine ? { localMachineId: opts.localMachine } : {}),
        ...(registryToken ? { registryToken } : {}),
        ...(registryFallbackTokens.length ? { registryFallbackTokens } : {}),
        ssmProfile: opts.ssmProfile,
        concurrency: Number.parseInt(opts.concurrency, 10) || 8,
        onProgress: (message) => process.stderr.write(`${message}\n`),
      });
      if (opts.json) printJson(report);
      else console.log(renderTable(report));
      // A blind sweep must not exit 0: "found nothing" and "could read nothing"
      // are different answers and only one of them is good news.
      if (opts.failOnGap && shouldFailGate(report)) process.exit(2);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("gates")
  .description("Classify every package's publish gate: present and passing, structurally unpassable, absent, or bypassed in practice")
  .option("--org <org>", "Org to scan (repeatable; default hasna and hasnaxyz)", collect, [])
  .option("--only <org/repo>", "Restrict to specific repos (repeatable)", collect, [])
  .option("--json", "Emit the full JSON report")
  .action(async (opts: { org: string[]; only: string[]; json?: boolean }) => {
    try {
      const report = await runPublishGates({
        ...(opts.org.length ? { orgs: opts.org } : {}),
        ...(opts.only.length ? { only: opts.only } : {}),
        onProgress: (message) => process.stderr.write(`${message}\n`),
      });
      if (opts.json) {
        printJson(report);
        return;
      }
      console.log(`publish gates  ${report.summary.needing_attention} of ${report.summary.packages} need attention\n`);
      for (const entry of report.entries) {
        if (entry.severity < 3) continue;
        console.log(`${(entry.packageName ?? entry.repo).padEnd(30)} ${entry.status.padEnd(24)} ${entry.reasons[0] ?? ""}`);
      }
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch(fail);
