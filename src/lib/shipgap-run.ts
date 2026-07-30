/** Orchestration: collect the facts, classify them, build the report. */

import {
  buildReport,
  classifyPackage,
  type PackageFacts,
  type ShipGapReport,
} from "./shipgap.js";
import {
  defaultRunner,
  enumerateOrgRepos,
  fetchBranchManifest,
  fetchCommitsSince,
  fetchRegistryFacts,
  loadManifestMachines,
  probeMachine,
  resolveCommitAt,
  type FleetProbe,
  type MachineRef,
  type OrgCompleteness,
  type RepoRef,
  type Runner,
} from "./shipgap-sources.js";

export interface ShipGapRunOptions {
  orgs?: string[];
  /** Only consider package names under these scopes; foreign forks are not our release discipline. */
  scopes?: string[];
  /** Historical replay instant. Omit for "now". */
  asOf?: string;
  /** Skip the fleet sweep (metadata-only run). */
  skipFleet?: boolean;
  /** Restrict to specific `org/repo` refs. */
  only?: string[];
  registryToken?: string;
  /** Extra credentials tried before concluding a restricted name is unpublished. */
  registryFallbackTokens?: string[];
  ssmProfile?: string;
  localMachineId?: string;
  runner?: Runner;
  concurrency?: number;
  onProgress?: (message: string) => void;
}

const DEFAULT_ORGS = ["hasna", "hasnaxyz"];
const DEFAULT_SCOPES = ["@hasna/", "@hasnaxyz/"];

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface FleetSweep {
  machines: MachineRef[];
  probes: FleetProbe[];
}

export function sweepFleet(options: ShipGapRunOptions = {}): FleetSweep {
  const runner = options.runner ?? defaultRunner;
  const machines = loadManifestMachines(runner);
  const probes = machines.map((machine) => {
    options.onProgress?.(`probing ${machine.friendlyName ?? machine.id}`);
    return probeMachine(machine, {
      runner,
      ssmProfile: options.ssmProfile,
      localMachineId: options.localMachineId,
    });
  });
  return { machines, probes };
}

export async function runShipGap(options: ShipGapRunOptions = {}): Promise<ShipGapReport> {
  const runner = options.runner ?? defaultRunner;
  const orgs = options.orgs ?? DEFAULT_ORGS;
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const concurrency = options.concurrency ?? 8;

  // --- inventory ------------------------------------------------------------
  const repos: RepoRef[] = [];
  const completeness: OrgCompleteness[] = [];
  for (const org of orgs) {
    options.onProgress?.(`enumerating ${org}`);
    const enumerated = enumerateOrgRepos(org, runner);
    repos.push(...enumerated.repos);
    completeness.push(enumerated.completeness);
  }
  const selected = options.only?.length
    ? repos.filter((ref) => options.only!.includes(`${ref.org}/${ref.repo}`))
    : repos;

  // --- fleet ----------------------------------------------------------------
  let sweep: FleetSweep = { machines: [], probes: [] };
  if (!options.skipFleet) {
    sweep = sweepFleet({ ...options, runner });
  }
  const reachable = sweep.probes.filter((probe) => probe.ok);
  const unreachable = sweep.probes
    .filter((probe) => !probe.ok)
    .map((probe) => ({ machine: probe.machine, reason: probe.reason ?? "unknown" }));
  const unreachableMap = Object.fromEntries(unreachable.map((entry) => [entry.machine, entry.reason]));

  // --- per repo -------------------------------------------------------------
  const entries = await mapWithConcurrency(selected, concurrency, async (ref) => {
    const at = options.asOf ? resolveCommitAt(ref, options.asOf, runner) ?? undefined : undefined;
    const manifest = fetchBranchManifest(ref, runner, at);

    const inScope = manifest.name != null && scopes.some((scope) => manifest.name!.startsWith(scope));

    let registry = {
      latest: null as string | null,
      latestPublishedAt: null as string | null,
      versions: [] as string[],
      found: false,
    };
    // A failed lookup is NOT an absent package. Keep the two apart all the way
    // to the report so a broken sweep can never render as a clean fleet.
    let registryStatus: PackageFacts["registryStatus"] = inScope ? "absent" : "unknown";
    let registryError: string | undefined;
    if (inScope) {
      try {
        registry = await fetchRegistryFacts(manifest.name!, {
          ...(options.registryToken ? { token: options.registryToken } : {}),
          ...(options.registryFallbackTokens?.length ? { fallbackTokens: options.registryFallbackTokens } : {}),
          ...(options.asOf ? { asOf: options.asOf } : {}),
        });
        registryStatus = registry.found ? "found" : "absent";
      } catch (error) {
        registryStatus = "unknown";
        registryError = error instanceof Error ? error.message : String(error);
        options.onProgress?.(`registry lookup FAILED for ${manifest.name}: ${registryError}`);
      }
    }

    let commits: PackageFacts["commitsSincePublish"] = [];
    let commitsTruncated = false;
    if (registry.latestPublishedAt) {
      const fetched = fetchCommitsSince(ref, registry.latestPublishedAt, runner, {
        ...(options.asOf ? { until: options.asOf } : {}),
      });
      commits = fetched.commits;
      commitsTruncated = fetched.truncated;
    }

    const installed: Record<string, string | null> = {};
    if (inScope && manifest.name) {
      for (const probe of reachable) {
        installed[probe.machine] = probe.packages[manifest.name] ?? null;
      }
    }

    return classifyPackage({
      org: ref.org,
      repo: ref.repo,
      defaultBranch: ref.defaultBranch,
      packageName: inScope ? manifest.name : null,
      branchVersion: inScope ? manifest.version : null,
      branchPrivate: manifest.private,
      registryStatus: inScope ? registryStatus : "absent",
      ...(registryError ? { registryError } : {}),
      registryLatest: registry.latest,
      registryLatestPublishedAt: registry.latestPublishedAt,
      registryVersions: registry.versions,
      commitsSincePublish: commits,
      commitsTruncated,
      installed,
      unreachable: unreachableMap,
    });
  });

  return buildReport(entries, {
    as_of: options.asOf ?? null,
    inventory: { orgs, repos_enumerated: repos.length, completeness },
    fleet: {
      machines_in_manifest: sweep.machines.length,
      measured: reachable.map((probe) => probe.machine).sort(),
      unreachable: unreachable.sort((a, b) => a.machine.localeCompare(b.machine)),
    },
  });
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const SHIP_LABEL: Record<string, string> = {
  unshipped_changes: "MERGED, NOT SHIPPED",
  behind_publish: "BUMPED, NOT PUBLISHED",
  never_published: "NEVER PUBLISHED",
  registry_unknown: "REGISTRY UNMEASURED",
  registry_ahead: "registry ahead of branch",
  shipped: "shipped",
  not_a_package: "-",
};

const FLEET_LABEL: Record<string, string> = {
  absent_everywhere: "INSTALLED NOWHERE",
  partial_rollout: "PARTIAL",
  uniformly_stale: "ALL STALE",
  version_skew: "SKEWED",
  current: "current",
  not_applicable: "-",
};

export function renderTable(report: ShipGapReport): string {
  const lines: string[] = [];
  lines.push(`ship-gap report  generated ${report.generated_at}${report.as_of ? `  as-of ${report.as_of}` : ""}`);
  lines.push("");
  for (const entry of report.inventory.completeness) {
    lines.push(
      `inventory  ${entry.org}: enumerated ${entry.enumerated}, org reports ${entry.org_reports} — ${entry.complete ? "COMPLETE" : "INCOMPLETE"}`,
    );
  }
  lines.push(
    `fleet      ${report.fleet.measured.length}/${report.fleet.machines_in_manifest} machines measured` +
      (report.fleet.unreachable.length
        ? `; UNREACHABLE: ${report.fleet.unreachable.map((entry) => `${entry.machine} (${entry.reason})`).join("; ")}`
        : ""),
  );
  lines.push("");
  lines.push(`MERGED BUT UNSHIPPED RIGHT NOW: ${report.summary.merged_but_unshipped}`);
  lines.push("");

  const rows = report.entries.filter((entry) => entry.severity > 0);
  const width = (pick: (entry: (typeof rows)[number]) => string, header: string) =>
    Math.max(header.length, ...rows.map((entry) => pick(entry).length), 0);
  const cols: Array<[string, (entry: (typeof rows)[number]) => string]> = [
    ["PACKAGE", (entry) => entry.packageName ?? entry.repo],
    ["BRANCH", (entry) => entry.branchVersion ?? "-"],
    ["NPM", (entry) => entry.registryLatest ?? "-"],
    ["SHIP", (entry) => SHIP_LABEL[entry.shipStatus] ?? entry.shipStatus],
    ["FLEET", (entry) => FLEET_LABEL[entry.fleetStatus] ?? entry.fleetStatus],
    ["INSTALLED", (entry) => (entry.fleet.measured ? `${entry.fleet.installed}/${entry.fleet.measured}` : "-")],
    ["COMMITS", (entry) => (entry.shippingCommitsSincePublish ? `${entry.commitCountsAreFloor ? ">=" : ""}${entry.shippingCommitsSincePublish}` : "-")],
    ["VERSIONS ON FLEET", (entry) => entry.fleet.distinctVersions.join(",") || "-"],
  ];
  const widths = cols.map(([header, pick]) => width(pick, header));
  lines.push(cols.map(([header], i) => header.padEnd(widths[i] ?? 0)).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const entry of rows) {
    lines.push(cols.map(([, pick], i) => pick(entry).padEnd(widths[i] ?? 0)).join("  "));
  }
  lines.push("");
  lines.push(`${rows.length} package(s) with a gap; ${report.summary.packages - rows.length} clean or not packages.`);
  return lines.join("\n");
}
