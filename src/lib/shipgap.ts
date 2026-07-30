/**
 * Ship-gap detection: the states between "merged" and "running".
 *
 * `reconcile` already answers "does the ledger agree with npm?". It cannot see
 * the two gaps that actually bit the fleet:
 *
 *   1. repo -> npm   a fix merged to the default branch that was never published,
 *                    either because nobody ran publish or because the merge
 *                    carried no version bump so the published dist still holds
 *                    the broken code.
 *   2. npm -> fleet  a version published correctly that no machine ever
 *                    installed, because publishing propagates to nothing.
 *
 * merged != published != installed != running. Each link needs its own artefact
 * and none may be inferred from the previous one. This module models both links
 * as pure functions over collected facts so they can be replayed against
 * history (see `--as-of`) and unit-tested against known incidents.
 */

// ---------------------------------------------------------------------------
// semver
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Returns <0, 0 or >0. Unparseable versions sort last but compare equal to each other. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // A release outranks any prerelease of the same tuple.
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ida = pa.prerelease[i];
    const idb = pb.prerelease[i];
    if (ida === undefined) return -1;
    if (idb === undefined) return 1;
    const na = /^\d+$/.test(ida) ? Number(ida) : null;
    const nb = /^\d+$/.test(idb) ? Number(idb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (ida !== idb) {
      return ida < idb ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// shipping-relevant paths
// ---------------------------------------------------------------------------

/**
 * Paths that cannot change what a consumer runs: prose, CI wiring, editor and
 * agent config. Everything else is treated as shipping-relevant.
 *
 * This is deliberately a denylist rather than an `src/**` allowlist. The
 * `@hasnaxyz/factory` #110 incident — a security fix that stopped the package
 * publishing publicly — touched only `package.json`, `scripts/` and `tests/`.
 * An `src/`-only rule would have reported that repo clean.
 */
const NON_SHIPPING_PATTERNS: RegExp[] = [
  /^docs\//,
  /^\.github\//,
  /^\.claude\//,
  /^\.codex\//,
  /^\.cursor\//,
  /^\.vscode\//,
  /^\.hasna\//,
  /\.md$/i,
  /^LICENSE/i,
  /^\.gitignore$/,
  /^\.editorconfig$/,
  /^\.npmignore$/,
  /^\.prettierrc/,
];

export function isShippingRelevantPath(path: string): boolean {
  return !NON_SHIPPING_PATTERNS.some((pattern) => pattern.test(path));
}

/** The narrower criterion named in the original incident brief, kept as a separate signal. */
export function isSrcPath(path: string): boolean {
  return path.startsWith("src/");
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export interface CommitFact {
  sha: string;
  committedAt: string;
  paths: string[];
  message?: string;
}

export interface PackageFacts {
  /** GitHub org, e.g. "hasna". */
  org: string;
  /** GitHub repo name, e.g. "projects". */
  repo: string;
  defaultBranch: string;
  /** package.json `name` on the default branch; null when the repo has no package.json. */
  packageName: string | null;
  /** package.json `version` on the default branch. */
  branchVersion: string | null;
  /** package.json `private: true` on the default branch. */
  branchPrivate: boolean;
  /**
   * Whether the registry actually answered.
   *
   * `absent` means the registry replied 404: the name genuinely is not published.
   * `unknown` means the lookup failed — auth, network, rate limit. These must
   * never collapse into one value. Treating a failed lookup as "not published"
   * is the same class of error as treating an empty list as an empty set, and it
   * would have this tool confidently report a published package as unshipped.
   */
  registryStatus: "found" | "absent" | "unknown";
  /** Reason the lookup failed, when `registryStatus` is `unknown`. */
  registryError?: string;
  /** dist-tags.latest from the npm registry API; null when absent or unknown. */
  registryLatest: string | null;
  /** Publish timestamp of `registryLatest`, ISO 8601. */
  registryLatestPublishedAt: string | null;
  /** Every version present in the registry document. */
  registryVersions: string[];
  /**
   * Commits on the default branch after `registryLatestPublishedAt` (and at or
   * before the as-of instant). Empty when nothing was published.
   */
  commitsSincePublish: CommitFact[];
  /** True when more commits exist than were fetched, so the counts are a floor. */
  commitsTruncated?: boolean;
  /**
   * Whether the commit history after the last publish was actually read.
   *
   * `unknown` means the lookup failed or returned only partially. It must NEVER
   * collapse into "no commits found", because that renders as `shipped` — this
   * detector answering "nothing to ship" precisely when it cannot see. The
   * registry axis has `registry_unknown` and the fleet axis discloses
   * `measured === 0`; this is the same rule applied to the third axis.
   */
  commitsStatus?: "measured" | "unknown";
  /** Reason the commit read failed, when `commitsStatus` is `unknown`. */
  commitsError?: string;
  /** Installed version per machine id; a machine present with `null` means "reachable, package absent". */
  installed: Record<string, string | null>;
  /** Machine ids that could not be measured at all, with the reason. */
  unreachable: Record<string, string>;
}

// ---------------------------------------------------------------------------
// outputs
// ---------------------------------------------------------------------------

export type ShipStatus =
  | "not_a_package"
  | "registry_unknown"
  | "commits_unknown"
  | "never_published"
  | "behind_publish"
  | "unshipped_changes"
  | "registry_ahead"
  | "shipped";

export type FleetStatus =
  | "not_applicable"
  | "absent_everywhere"
  | "partial_rollout"
  | "version_skew"
  | "uniformly_stale"
  | "current";

export const SHIP_SEVERITY: Record<ShipStatus, number> = {
  unshipped_changes: 5,
  behind_publish: 4,
  never_published: 3,
  // An unmeasured package is not a clean package. These rank above "registry
  // ahead" so a sweep that silently lost its registry auth, or could not read a
  // repo's commit history, cannot read as green.
  registry_unknown: 3,
  commits_unknown: 3,
  registry_ahead: 2,
  shipped: 0,
  not_a_package: 0,
};

export const FLEET_SEVERITY: Record<FleetStatus, number> = {
  absent_everywhere: 4,
  partial_rollout: 3,
  uniformly_stale: 3,
  version_skew: 2,
  current: 0,
  not_applicable: 0,
};

export interface FleetBreakdown {
  /** Machines measured (reachable), whether or not the package was present. */
  measured: number;
  installed: number;
  missing: number;
  /** Reachable machines whose installed version equals `registryLatest`. */
  atLatest: number;
  /** Reachable machines with the package installed at a version below `registryLatest`. */
  stale: number;
  /** Reachable machines ahead of the registry (local build, or an unpublished install). */
  ahead: number;
  distinctVersions: string[];
  /** Installed version -> machine ids, for the machines that have it. */
  byVersion: Record<string, string[]>;
  missingOn: string[];
  unreachable: string[];
}

export interface ShipGapEntry {
  repo: string;
  packageName: string | null;
  branchVersion: string | null;
  registryLatest: string | null;
  registryLatestPublishedAt: string | null;
  shipStatus: ShipStatus;
  fleetStatus: FleetStatus;
  severity: number;
  /** Commits after the last publish that could change what a consumer runs. */
  shippingCommitsSincePublish: number;
  /** Subset of the above touching `src/` specifically. */
  srcCommitsSincePublish: number;
  /** Newest shipping-relevant commit sha after the last publish, if any. */
  latestUnshippedSha: string | null;
  /** When true, the commit counts above are a lower bound, not an exact figure. */
  commitCountsAreFloor: boolean;
  fleet: FleetBreakdown;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

function emptyFleet(unreachable: string[]): FleetBreakdown {
  return {
    measured: 0,
    installed: 0,
    missing: 0,
    atLatest: 0,
    stale: 0,
    ahead: 0,
    distinctVersions: [],
    byVersion: {},
    missingOn: [],
    unreachable,
  };
}

export function summarizeFleet(
  installed: Record<string, string | null>,
  unreachable: string[],
  registryLatest: string | null,
): FleetBreakdown {
  const byVersion: Record<string, string[]> = {};
  const missingOn: string[] = [];
  let atLatest = 0;
  let stale = 0;
  let ahead = 0;

  for (const machine of Object.keys(installed).sort()) {
    const version = installed[machine];
    if (version === null || version === undefined) {
      missingOn.push(machine);
      continue;
    }
    (byVersion[version] ??= []).push(machine);
    if (registryLatest) {
      const cmp = compareVersions(version, registryLatest);
      if (cmp === 0) atLatest += 1;
      else if (cmp < 0) stale += 1;
      else ahead += 1;
    }
  }

  const measured = Object.keys(installed).length;
  return {
    measured,
    installed: measured - missingOn.length,
    missing: missingOn.length,
    atLatest,
    stale,
    ahead,
    distinctVersions: Object.keys(byVersion).sort(compareVersions),
    byVersion,
    missingOn,
    unreachable: [...unreachable].sort(),
  };
}

function classifyShip(facts: PackageFacts, reasons: string[]): ShipStatus {
  const { packageName, branchVersion, branchPrivate, registryLatest } = facts;

  // A repo with no package.json, or a package that exists only inside the repo
  // and was never on the registry, cannot have a ship gap.
  if (!packageName || !branchVersion) {
    reasons.push("no package.json name/version on the default branch");
    return "not_a_package";
  }

  if (facts.registryStatus === "unknown") {
    reasons.push(
      `the registry could not be queried for ${packageName}${facts.registryError ? ` (${facts.registryError})` : ""} — state UNMEASURED, not clean`,
    );
    return "registry_unknown";
  }

  if (!registryLatest) {
    if (branchPrivate) {
      reasons.push("package.json declares private:true and the name is absent from the registry");
      return "not_a_package";
    }
    reasons.push(`declared publishable at ${branchVersion} but the name has never appeared on the registry`);
    return "never_published";
  }

  // `private: true` while the name IS on the registry is worth saying out loud:
  // either the flag was added to stop future publishes (and the already-public
  // artefact is still out there), or a publish escaped the flag.
  if (branchPrivate) {
    reasons.push(
      `package.json declares private:true yet ${registryLatest} is published — the published artefact predates or bypasses the flag`,
    );
  }

  const cmp = compareVersions(branchVersion, registryLatest);
  if (cmp > 0) {
    reasons.push(
      `default branch is at ${branchVersion}, registry latest is ${registryLatest} — the bump merged but was never published`,
    );
    return "behind_publish";
  }
  if (cmp < 0) {
    reasons.push(
      `registry latest ${registryLatest} is ahead of the default branch ${branchVersion} — published from somewhere other than this branch, or the branch was reverted`,
    );
    return "registry_ahead";
  }

  // Only now, having established that branch and registry agree on the version,
  // does the commit history decide the answer.
  //
  // Positive evidence outranks partial blindness. If even ONE readable commit
  // is shipping-relevant, the gap is proven and no amount of unread history
  // makes it less proven — knowing of a real gap is strictly more information
  // than knowing nothing. Reporting `commits_unknown` here would drop a package
  // we KNOW is unshipped out of the headline count.
  const shipping = facts.commitsSincePublish.filter((commit) => commit.paths.some(isShippingRelevantPath));
  if (shipping.length > 0) {
    const src = shipping.filter((commit) => commit.paths.some(isSrcPath));
    // Truncation and unread commits both mean the same thing for the counts:
    // what we report is a lower bound.
    const partial = facts.commitsTruncated === true || facts.commitsStatus === "unknown";
    const floor = partial ? "at least " : "";
    reasons.push(
      `${floor}${shipping.length} shipping-relevant commit(s) (${src.length} touching src/) landed on ${facts.defaultBranch} after ${registryLatest} was published at ${facts.registryLatestPublishedAt} — with no version bump, the published dist does not contain them`,
    );
    if (facts.commitsStatus === "unknown") {
      reasons.push(
        `part of the history could not be read${facts.commitsError ? ` (${facts.commitsError})` : ""}, so the counts above are a lower bound — but the gap is already proven by what WAS read`,
      );
    }
    return "unshipped_changes";
  }

  // No positive evidence. Now an unreadable history is decisive: the honest
  // answer is that we do not know — never "shipped". This detector's whole
  // purpose is finding merged-but-unshipped work, so answering "clean" when
  // blind is the exact failure it exists to catch.
  if (facts.commitsStatus === "unknown") {
    reasons.push(
      `branch and registry agree at ${registryLatest}, but the commit history since that publish could not be read${facts.commitsError ? ` (${facts.commitsError})` : ""} — UNMEASURED, not clean; an unshipped fix would be invisible here`,
    );
    return "commits_unknown";
  }

  reasons.push(`default branch and registry agree at ${registryLatest} with no shipping-relevant commits since`);
  return "shipped";
}

function classifyFleet(facts: PackageFacts, fleet: FleetBreakdown, reasons: string[]): FleetStatus {
  if (!facts.registryLatest) return "not_applicable";
  if (fleet.measured === 0) {
    reasons.push("no machine could be measured; fleet state unknown");
    return "not_applicable";
  }
  if (fleet.installed === 0) {
    reasons.push(`${facts.registryLatest} is published but installed on none of the ${fleet.measured} measured machines`);
    return "absent_everywhere";
  }
  if (fleet.missing > 0) {
    reasons.push(
      `installed on ${fleet.installed}/${fleet.measured} measured machines; absent on ${fleet.missingOn.join(", ")}`,
    );
    return "partial_rollout";
  }
  if (fleet.distinctVersions.length > 1) {
    reasons.push(
      `installed everywhere but at ${fleet.distinctVersions.length} different versions: ${fleet.distinctVersions.join(", ")}`,
    );
    return "version_skew";
  }
  if (fleet.stale === fleet.installed) {
    reasons.push(
      `every measured machine is uniformly on ${fleet.distinctVersions[0]} while the registry serves ${facts.registryLatest}`,
    );
    return "uniformly_stale";
  }
  reasons.push(`all ${fleet.installed} measured machines are on the registry latest ${facts.registryLatest}`);
  return "current";
}

export function classifyPackage(facts: PackageFacts): ShipGapEntry {
  const reasons: string[] = [];
  const shipStatus = classifyShip(facts, reasons);
  const fleet = summarizeFleet(facts.installed, Object.keys(facts.unreachable), facts.registryLatest);
  const fleetStatus =
    shipStatus === "not_a_package" && !facts.registryLatest
      ? "not_applicable"
      : classifyFleet(facts, fleet, reasons);

  const shipping = facts.commitsSincePublish.filter((commit) => commit.paths.some(isShippingRelevantPath));
  const src = shipping.filter((commit) => commit.paths.some(isSrcPath));

  return {
    repo: `${facts.org}/${facts.repo}`,
    packageName: facts.packageName,
    branchVersion: facts.branchVersion,
    registryLatest: facts.registryLatest,
    registryLatestPublishedAt: facts.registryLatestPublishedAt,
    shipStatus,
    fleetStatus,
    severity: Math.max(SHIP_SEVERITY[shipStatus], FLEET_SEVERITY[fleetStatus]),
    shippingCommitsSincePublish: shipping.length,
    srcCommitsSincePublish: src.length,
    latestUnshippedSha: shipping[0]?.sha ?? null,
    commitCountsAreFloor: facts.commitsTruncated === true || facts.commitsStatus === "unknown",
    fleet,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export interface ShipGapReport {
  schema: "hasna-releases.shipgap.v1";
  generated_at: string;
  /** Historical replay instant, when the run was not "now". */
  as_of: string | null;
  inventory: {
    orgs: string[];
    repos_enumerated: number;
    /** Per-org proof that enumeration was complete, not merely non-empty. */
    completeness: Array<{ org: string; enumerated: number; org_reports: number; complete: boolean }>;
  };
  fleet: {
    machines_in_manifest: number;
    /**
     * Whether a fleet sweep was attempted at all. `false` means `--skip-fleet`:
     * the operator deliberately did not ask, which is not the same as asking and
     * learning nothing. The gate distinguishes the two.
     */
    attempted: boolean;
    measured: string[];
    unreachable: Array<{ machine: string; reason: string }>;
  };
  summary: {
    packages: number;
    merged_but_unshipped: number;
    /**
     * Packages an axis could not measure. A sweep with a non-zero count here has
     * NOT proven the fleet clean, however few gaps it reports.
     */
    unmeasured: number;
    by_ship_status: Record<string, number>;
    by_fleet_status: Record<string, number>;
  };
  entries: ShipGapEntry[];
}

/**
 * The count that matters: repos whose default branch holds work the registry
 * does not serve.
 *
 * Deliberately excludes the unknown states. `commits_unknown` and
 * `registry_unknown` are *unmeasured*, not *known clean* and not *known
 * broken* — folding either into this figure would overstate it. They are
 * counted by `unmeasuredPackages` instead, and a gate must consult both.
 */
export function mergedButUnshipped(entries: ShipGapEntry[]): ShipGapEntry[] {
  return entries.filter(
    (entry) => entry.shipStatus === "unshipped_changes" || entry.shipStatus === "behind_publish",
  );
}

/**
 * Packages where the SHIP axis could not be read — the registry lookup failed,
 * or the commit history was unreadable with no positive evidence in what was.
 *
 * Deliberately scoped to `shipStatus` and NOT to the fleet axis. `--skip-fleet`
 * is a legitimate, explicitly requested mode, and a package whose fleet state
 * was never sought is not "unmeasured" in any sense the operator cares about.
 * A fleet sweep that was ATTEMPTED and reached nothing is a different thing and
 * does gate — see `shouldFailGate`, which checks it separately.
 */
export function unmeasuredPackages(entries: ShipGapEntry[]): ShipGapEntry[] {
  return entries.filter(
    (entry) => entry.shipStatus === "commits_unknown" || entry.shipStatus === "registry_unknown",
  );
}

/**
 * Whether `--fail-on-gap` should exit non-zero.
 *
 * A blind sweep must not exit 0. Exiting 0 because nothing was found, when the
 * reason nothing was found is that nothing could be read, is the same false
 * reassurance this tool exists to detect.
 */
export function shouldFailGate(report: ShipGapReport): boolean {
  if (report.summary.merged_but_unshipped > 0) return true;
  if (report.summary.unmeasured > 0) return true;
  // A fleet sweep that was ATTEMPTED and reached no machine is a blind axis,
  // which is the whole subject of this gate. Deliberately skipping the fleet is
  // not: `--skip-fleet` is an explicit request for a metadata-only answer, and
  // failing it would make the flag useless. Intent is the distinction.
  if (report.fleet.attempted && report.fleet.machines_in_manifest > 0 && report.fleet.measured.length === 0) {
    return true;
  }
  return false;
}

export function buildReport(
  entries: ShipGapEntry[],
  meta: Pick<ShipGapReport, "as_of" | "inventory" | "fleet">,
): ShipGapReport {
  const byShip: Record<string, number> = {};
  const byFleet: Record<string, number> = {};
  for (const entry of entries) {
    byShip[entry.shipStatus] = (byShip[entry.shipStatus] ?? 0) + 1;
    byFleet[entry.fleetStatus] = (byFleet[entry.fleetStatus] ?? 0) + 1;
  }
  const sorted = [...entries].sort(
    (a, b) => b.severity - a.severity || a.repo.localeCompare(b.repo),
  );
  return {
    schema: "hasna-releases.shipgap.v1",
    generated_at: new Date().toISOString(),
    ...meta,
    summary: {
      packages: entries.length,
      merged_but_unshipped: mergedButUnshipped(entries).length,
      unmeasured: unmeasuredPackages(entries).length,
      by_ship_status: byShip,
      by_fleet_status: byFleet,
    },
    entries: sorted,
  };
}
