import { randomUUID } from "node:crypto";
import { ledgerDbPath } from "./config.js";
import { ReleaseLedger } from "./ledger.js";
import { deriveAppId } from "./record.js";
import { parseRelease, type Release } from "../vendor/contracts.js";
import type { CommandRunner } from "./fanout.js";
import { spawnSync } from "node:child_process";

const PLACEHOLDER_GIT_SHA = "0000000";

export type ReconcileStatus = "in_sync" | "backfilled" | "registry_unreachable" | "not_on_registry" | "error";

export interface ReconcileEntry {
  package: string;
  status: ReconcileStatus;
  registry_version?: string;
  ledger_latest?: string;
  flagged?: boolean;
  backfilled_record_id?: string;
  detail?: string;
}

export interface ReconcileReport {
  schema: "open-releases.reconcile.v1";
  generated_at: string;
  summary: {
    packages: number;
    in_sync: number;
    backfilled: number;
    unreachable: number;
    errors: number;
  };
  entries: ReconcileEntry[];
}

export interface ReconcileOptions {
  packages?: string[];
  dataDir?: string;
  ledger?: ReleaseLedger;
  runner?: CommandRunner;
  timeoutMs?: number;
  now?: () => Date;
}

function spawnCommand(command: string, args: string[], opts: { timeoutMs: number }): ReturnType<CommandRunner> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } } : {}),
  };
}

interface RegistryView {
  version?: string;
  gitHead?: string;
}

function npmView(pkg: string, runner: CommandRunner, timeoutMs: number): { ok: boolean; view?: RegistryView; missing?: boolean; error?: string } {
  const result = runner("npm", ["view", pkg, "version", "gitHead", "--json"], { timeoutMs });
  if (result.error?.code === "ENOENT") return { ok: false, error: "npm CLI not found" };
  if (result.status !== 0) {
    const stderr = result.stderr || result.error?.message || `npm view exited ${result.status}`;
    if (/E404|404 Not Found|is not in this registry/i.test(stderr)) return { ok: true, missing: true };
    return { ok: false, error: stderr.slice(0, 300) };
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}") as RegistryView | string;
    // `npm view <pkg> version gitHead --json` returns an object; with a single
    // field npm collapses to a bare string, so normalize both shapes.
    if (typeof parsed === "string") return { ok: true, view: { version: parsed } };
    return { ok: true, view: parsed };
  } catch {
    return { ok: false, error: "could not parse npm view output" };
  }
}

function buildBackfilledRelease(pkg: string, view: RegistryView, ledger: ReleaseLedger, now: Date): Release {
  const timestamp = now.toISOString();
  const gitHead = view.gitHead && /^[0-9a-f]{7,40}$/.test(view.gitHead) ? view.gitHead : PLACEHOLDER_GIT_SHA;
  const previous = ledger.latestFor(pkg);
  return parseRelease({
    schema: "hasna.release.v1",
    id: `rel-${randomUUID()}`,
    createdAt: timestamp,
    appId: previous?.appId ?? deriveAppId(pkg),
    package: pkg,
    version: view.version!,
    gitSha: gitHead,
    publishedAt: timestamp,
    publishPath: "backfilled",
    evidenceRefs: [
      {
        id: `evd-${randomUUID()}`,
        kind: "npm-registry",
        uri: `https://www.npmjs.com/package/${pkg}/v/${view.version}`,
        summary: "Backfilled by releases reconcile from npm registry latest",
      },
    ],
    metadata: {
      flagged: "publish-bypassed-ledger",
      gitShaPlaceholder: gitHead === PLACEHOLDER_GIT_SHA,
      reconciledAt: timestamp,
    },
  });
}

/**
 * Diff npm registry latest versions against ledger records. Registry versions
 * missing from the ledger are backfilled as `publishPath=backfilled` and
 * flagged as ledger-bypassing publishes. Offline/unreachable registries are
 * reported gracefully per package instead of failing the run.
 */
export function reconcileReleases(options: ReconcileOptions = {}): ReconcileReport {
  const ledger = options.ledger ?? new ReleaseLedger(ledgerDbPath(options.dataDir));
  const ownLedger = !options.ledger;
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? (() => new Date());
  const entries: ReconcileEntry[] = [];

  try {
    const packages = options.packages?.length ? options.packages : ledger.listPackages();
    for (const pkg of packages) {
      const ledgerLatest = ledger.latestFor(pkg)?.version;
      const lookup = npmView(pkg, runner, timeoutMs);
      if (!lookup.ok) {
        entries.push({ package: pkg, status: "registry_unreachable", ledger_latest: ledgerLatest, detail: lookup.error });
        continue;
      }
      if (lookup.missing) {
        entries.push({ package: pkg, status: "not_on_registry", ledger_latest: ledgerLatest });
        continue;
      }
      const version = lookup.view?.version;
      if (!version) {
        entries.push({ package: pkg, status: "error", ledger_latest: ledgerLatest, detail: "npm view returned no version" });
        continue;
      }
      if (ledger.has(pkg, version)) {
        entries.push({ package: pkg, status: "in_sync", registry_version: version, ledger_latest: ledgerLatest });
        continue;
      }
      try {
        const backfilled = ledger.insert(buildBackfilledRelease(pkg, lookup.view!, ledger, now()));
        entries.push({
          package: pkg,
          status: "backfilled",
          registry_version: version,
          ledger_latest: ledgerLatest,
          flagged: true,
          backfilled_record_id: backfilled.id,
          detail: "npm latest was missing from the ledger; publish bypassed the release ledger",
        });
      } catch (error) {
        entries.push({
          package: pkg,
          status: "error",
          registry_version: version,
          ledger_latest: ledgerLatest,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    if (ownLedger) ledger.close();
  }

  return {
    schema: "open-releases.reconcile.v1",
    generated_at: new Date().toISOString(),
    summary: {
      packages: entries.length,
      in_sync: entries.filter((entry) => entry.status === "in_sync").length,
      backfilled: entries.filter((entry) => entry.status === "backfilled").length,
      unreachable: entries.filter((entry) => entry.status === "registry_unreachable").length,
      errors: entries.filter((entry) => entry.status === "error").length,
    },
    entries,
  };
}
