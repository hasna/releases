/**
 * Fact collection for ship-gap detection.
 *
 * Every source here is chosen because the obvious alternative is known to lie:
 *
 *  - The npm REGISTRY API is authoritative for "is it published", not `npm view`.
 *    During the @hasna/projects 0.1.96 publish on 2026-07-30, `npm view` kept
 *    returning 0.1.95 for minutes after a successful publish while
 *    registry.npmjs.org already served 0.1.96. `reconcile` still uses `npm view`;
 *    this module deliberately does not.
 *  - Repo enumeration comes from the GitHub org API and is CHECKED against the
 *    org's own public/private counts. A list that looks authoritative and is not
 *    is the failure mode this whole tool exists to catch.
 *  - Fleet membership comes from the machines manifest, not from a hand-kept
 *    list. A rollout that covered 3 of 18 machines is what started this.
 *  - EC2 stations are probed over SSM when ssh cannot reach them; their manifest
 *    address is a VPC-internal name that does not resolve off-VPC, so an
 *    ssh-only sweep silently undercounts the fleet and reports them dead.
 */

import { spawnSync } from "node:child_process";
import type { CommitFact } from "./shipgap.js";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => RunResult;

export const defaultRunner: Runner = (command, args, opts = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface RepoRef {
  org: string;
  repo: string;
  defaultBranch: string;
  archived: boolean;
}

export interface OrgCompleteness {
  org: string;
  enumerated: number;
  org_reports: number;
  complete: boolean;
}

function gh(runner: Runner, args: string[], timeoutMs = 120_000): unknown {
  const result = runner("gh", args, { timeoutMs });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  }
  return JSON.parse(result.stdout || "null");
}

/**
 * Enumerate an org's repos and prove the list complete by comparing its length
 * with the counts the org itself reports. Returns both so the caller can record
 * the proof rather than assert completeness on faith.
 */
export function enumerateOrgRepos(org: string, runner: Runner = defaultRunner): {
  repos: RepoRef[];
  completeness: OrgCompleteness;
} {
  const raw = runner("gh", [
    "api",
    `orgs/${org}/repos?per_page=100&type=all`,
    "--paginate",
    "--jq",
    ".[] | {name, defaultBranch: .default_branch, archived}",
  ], { timeoutMs: 180_000 });
  if (raw.status !== 0) {
    throw new Error(`failed to enumerate org ${org}: ${(raw.stderr || raw.stdout).slice(0, 300)}`);
  }
  const repos: RepoRef[] = raw.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as { name: string; defaultBranch: string; archived: boolean };
      return { org, repo: parsed.name, defaultBranch: parsed.defaultBranch, archived: parsed.archived };
    });

  const meta = gh(runner, [
    "api",
    `orgs/${org}`,
    "--jq",
    "{public: .public_repos, private: .total_private_repos}",
  ]) as { public: number; private: number };
  const expected = (meta.public ?? 0) + (meta.private ?? 0);

  return {
    repos,
    completeness: { org, enumerated: repos.length, org_reports: expected, complete: repos.length === expected },
  };
}

export interface BranchManifest {
  name: string | null;
  version: string | null;
  private: boolean;
}

export function fetchBranchManifest(ref: RepoRef, runner: Runner = defaultRunner, at?: string): BranchManifest {
  const query = at ? `?ref=${encodeURIComponent(at)}` : "";
  const result = runner(
    "gh",
    ["api", `repos/${ref.org}/${ref.repo}/contents/package.json${query}`, "--jq", ".content"],
    { timeoutMs: 60_000 },
  );
  if (result.status !== 0) return { name: null, version: null, private: false };
  try {
    const decoded = Buffer.from(result.stdout.replace(/\s/g, ""), "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { name?: string; version?: string; private?: boolean };
    return {
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      private: parsed.private === true,
    };
  } catch {
    return { name: null, version: null, private: false };
  }
}

/** Resolve the newest commit on `branch` at or before `until`, for historical replay. */
export function resolveCommitAt(ref: RepoRef, until: string, runner: Runner = defaultRunner): string | null {
  const result = runner(
    "gh",
    [
      "api",
      `repos/${ref.org}/${ref.repo}/commits?sha=${encodeURIComponent(ref.defaultBranch)}&until=${encodeURIComponent(until)}&per_page=1`,
      "--jq",
      ".[0].sha // empty",
    ],
    { timeoutMs: 60_000 },
  );
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Commits on the default branch strictly after `since` (and at or before
 * `until`, when replaying history), each with the file paths it touched.
 *
 * The GitHub list-commits endpoint does not return file lists, so each commit is
 * fetched individually. `limit` bounds that fan-out: a repo with hundreds of
 * commits since its last publish is already unambiguously unshipped and does not
 * need every path enumerated to prove it.
 */
export function fetchCommitsSince(
  ref: RepoRef,
  since: string,
  runner: Runner = defaultRunner,
  options: { until?: string; limit?: number } = {},
): { commits: CommitFact[]; truncated: boolean; ok: boolean; error?: string } {
  const limit = options.limit ?? 20;
  const untilParam = options.until ? `&until=${encodeURIComponent(options.until)}` : "";
  const listed = runner(
    "gh",
    [
      "api",
      `repos/${ref.org}/${ref.repo}/commits?sha=${encodeURIComponent(ref.defaultBranch)}&since=${encodeURIComponent(since)}${untilParam}&per_page=${limit + 1}`,
      "--jq",
      ".[] | .sha",
    ],
    { timeoutMs: 60_000 },
  );
  if (listed.status !== 0) {
    // An unreadable history is NOT an empty history. Returning zero commits here
    // makes the classifier answer "shipped" for a package it could not inspect.
    return {
      commits: [],
      truncated: false,
      ok: false,
      error: (listed.stderr || listed.stdout).trim().split("\n").pop()?.slice(0, 200) || "commit list failed",
    };
  }
  const shas = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const truncated = shas.length > limit;

  const commits: CommitFact[] = [];
  const unreadable: string[] = [];
  for (const sha of shas.slice(0, limit)) {
    const detail = runner(
      "gh",
      [
        "api",
        `repos/${ref.org}/${ref.repo}/commits/${sha}`,
        "--jq",
        "{sha, committedAt: .commit.committer.date, message: .commit.message, paths: [.files[]?.filename]}",
      ],
      { timeoutMs: 60_000 },
    );
    if (detail.status !== 0) {
      // Partial blindness is still blindness: a commit we could not read may be
      // the one carrying the unshipped fix.
      unreadable.push(sha.slice(0, 8));
      continue;
    }
    try {
      const parsed = JSON.parse(detail.stdout) as CommitFact;
      // The publish itself commonly lands as a version-bump commit at the same
      // instant; `since` is exclusive on the API but equal timestamps slip
      // through, so drop anything not strictly after.
      if (new Date(parsed.committedAt).getTime() <= new Date(since).getTime()) continue;
      commits.push(parsed);
    } catch {
      unreadable.push(sha.slice(0, 8));
    }
  }
  if (unreadable.length > 0) {
    return {
      commits,
      truncated,
      ok: false,
      error: `could not read ${unreadable.length} commit(s): ${unreadable.slice(0, 5).join(", ")}`,
    };
  }
  return { commits, truncated, ok: true };
}

// ---------------------------------------------------------------------------
// npm registry (NOT `npm view`)
// ---------------------------------------------------------------------------

export interface RegistryFacts {
  latest: string | null;
  latestPublishedAt: string | null;
  versions: string[];
  /** Version -> publish time, used to reconstruct "what was latest at instant T". */
  times: Record<string, string>;
  found: boolean;
}

export interface RegistryOptions {
  /** Bearer token for restricted scopes. Never logged, never echoed. */
  token?: string;
  /**
   * Additional credentials to try before concluding a name is unpublished.
   *
   * On a restricted scope, "404" and "your token cannot see this" are the same
   * HTTP response. Measured on 2026-07-30: `$NPM_TOKEN` in the fleet environment
   * is a DIFFERENT token from the one in `~/.npmrc`, and it cannot read
   * `@hasnaxyz`. Preferring it made a published package report as never
   * published — the exact false-clean this tool exists to prevent. So absence is
   * only concluded when every available credential agrees.
   */
  fallbackTokens?: string[];
  registry?: string;
  asOf?: string;
  fetchImpl?: typeof fetch;
}

export async function fetchRegistryFacts(name: string, options: RegistryOptions = {}): Promise<RegistryFacts> {
  const registry = options.registry ?? "https://registry.npmjs.org";
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${registry}/${name.replace("/", "%2F")}`;

  const candidates = [options.token, ...(options.fallbackTokens ?? [])].filter(
    (token, index, all): token is string | undefined =>
      token === undefined ? index === 0 && all.length === 1 : all.indexOf(token) === index,
  );
  if (candidates.length === 0) candidates.push(undefined as unknown as string);

  let response: Awaited<ReturnType<typeof doFetch>> | null = null;
  for (const candidate of candidates) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (candidate) headers.Authorization = `Bearer ${candidate}`;
    response = await doFetch(url, { headers });
    // Only a 404/401/403 is worth retrying with another credential; anything
    // else is a real answer.
    if (response.status !== 404 && response.status !== 401 && response.status !== 403) break;
  }

  if (!response || response.status === 404 || response.status === 401 || response.status === 403) {
    if (response && response.status !== 404) {
      throw new Error(`registry ${response.status} for ${name} — no available credential could read it`);
    }
    return { latest: null, latestPublishedAt: null, versions: [], times: {}, found: false };
  }
  if (!response.ok) {
    throw new Error(`registry ${response.status} for ${name}`);
  }
  const doc = (await response.json()) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
    time?: Record<string, string>;
  };

  const times: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc.time ?? {})) {
    if (key === "created" || key === "modified") continue;
    times[key] = value;
  }
  const versions = Object.keys(doc.versions ?? times);

  // Reconstruct latest-as-of rather than trusting dist-tags, which only ever
  // describes now. This is what makes historical replay honest.
  let latest: string | null = doc["dist-tags"]?.latest ?? null;
  if (options.asOf) {
    const cutoff = new Date(options.asOf).getTime();
    let best: { version: string; at: number } | null = null;
    for (const [version, at] of Object.entries(times)) {
      const stamp = new Date(at).getTime();
      if (stamp > cutoff) continue;
      if (!best || stamp > best.at) best = { version, at: stamp };
    }
    latest = best?.version ?? null;
  }

  return {
    latest,
    latestPublishedAt: latest ? (times[latest] ?? null) : null,
    versions,
    times,
    found: true,
  };
}

// ---------------------------------------------------------------------------
// fleet
// ---------------------------------------------------------------------------

export interface MachineRef {
  id: string;
  friendlyName?: string;
  hostname?: string;
  sshAddress?: string;
  tailscaleName?: string;
  connection?: string;
}

export interface FleetProbe {
  machine: string;
  ok: boolean;
  transport: "local" | "ssh" | "ssm" | null;
  reason?: string;
  /** package name -> installed version */
  packages: Record<string, string>;
}

export function loadManifestMachines(runner: Runner = defaultRunner): MachineRef[] {
  const result = runner("machines", ["manifest", "list", "--json"], { timeoutMs: 60_000 });
  if (result.status !== 0) {
    throw new Error(`machines manifest list failed: ${(result.stderr || result.stdout).slice(0, 200)}`);
  }
  const parsed = JSON.parse(result.stdout) as { machines?: MachineRef[] };
  return parsed.machines ?? [];
}

/**
 * Shell that enumerates globally installed packages for the given scopes under
 * the invoking user's bun global root. Emitted as `name<TAB>version` lines.
 */
export function installedPackagesScript(scopes: string[], home = "$HOME"): string {
  const list = scopes.join(" ");
  return [
    `for __s in ${list}; do`,
    `for __d in ${home}/.bun/install/global/node_modules/$__s/*/package.json; do`,
    `[ -f "$__d" ] || continue;`,
    `__n=$(grep -m1 '"name"' "$__d" | cut -d'"' -f4);`,
    `__v=$(grep -m1 '"version"' "$__d" | cut -d'"' -f4);`,
    `printf '%s\\t%s\\n' "$__n" "$__v";`,
    `done; done`,
  ].join(" ");
}

/**
 * Wrap a shell payload in single quotes so the enclosing shell performs no
 * expansion on it.
 *
 * Double-quoting here is a silent data-loss bug: SSM runs the command as root,
 * so a double-quoted payload has its `$var` references expanded by that root
 * shell before `sudo` ever starts. The inner script then reads empty variables,
 * lists nothing, exits 0, and the machine reports zero installed packages while
 * actually holding dozens. Measured on station17: 0 reported against 42 real.
 */
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseInstalled(stdout: string): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [name, version] = line.split("\t");
    if (name && version) packages[name.trim()] = version.trim();
  }
  return packages;
}

/**
 * A probe that succeeds but returns nothing is indistinguishable from a probe
 * whose payload silently broke, and the second is what actually happened. A
 * machine in this fleet always carries at least a handful of scoped packages, so
 * an empty list is treated as an unreliable measurement rather than as evidence
 * of an empty set. Set `minPackages: 0` to accept genuinely bare machines.
 */
export const DEFAULT_MIN_PACKAGES = 1;

export interface ProbeOptions {
  scopes?: string[];
  /** Reject a probe returning fewer than this many packages as unreliable. */
  minPackages?: number;
  runner?: Runner;
  timeoutMs?: number;
  /** AWS profile owning the SSM-managed stations. */
  ssmProfile?: string;
  /** Current machine id, probed without a network hop. */
  localMachineId?: string;
  ssmPollAttempts?: number;
  ssmPollDelayMs?: number;
}

function probeSsh(machine: MachineRef, script: string, runner: Runner, timeoutMs: number): FleetProbe | null {
  const target = machine.sshAddress ?? machine.tailscaleName ?? machine.hostname;
  if (!target) return null;
  const result = runner(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=no", target, script],
    { timeoutMs },
  );
  if (result.status !== 0) {
    return { machine: machine.id, ok: false, transport: null, reason: result.stderr.trim().split("\n").pop() ?? "ssh failed", packages: {} };
  }
  return { machine: machine.id, ok: true, transport: "ssh", packages: parseInstalled(result.stdout) };
}

/**
 * SSM runs the payload as root. Anything reading `$HOME` therefore reads root's
 * home and reports the wrong installed versions, so the payload is re-entered as
 * the owning user with a login shell.
 */
function probeSsm(
  machine: MachineRef,
  script: string,
  runner: Runner,
  options: Required<Pick<ProbeOptions, "ssmProfile" | "ssmPollAttempts" | "ssmPollDelayMs">>,
  user: string,
): FleetProbe | null {
  const name = machine.hostname ?? machine.friendlyName ?? machine.id;
  const lookup = runner(
    "aws",
    [
      "ssm", "describe-instance-information",
      "--profile", options.ssmProfile,
      "--filters", `Key=InstanceIds,Values=`,
      "--query", `InstanceInformationList[?ComputerName=='${name}'].InstanceId`,
      "--output", "text",
    ],
    { timeoutMs: 60_000 },
  );
  // The filter form above is rejected by some CLI versions; fall back to a plain describe.
  let instanceId = lookup.status === 0 ? lookup.stdout.trim() : "";
  if (!instanceId) {
    const all = runner(
      "aws",
      [
        "ssm", "describe-instance-information",
        "--profile", options.ssmProfile,
        "--query", `InstanceInformationList[?ComputerName=='${name}'].InstanceId`,
        "--output", "text",
      ],
      { timeoutMs: 60_000 },
    );
    if (all.status !== 0) return null;
    instanceId = all.stdout.trim();
  }
  if (!instanceId || instanceId === "None") return null;

  const wrapped = `sudo -u ${user} -H bash -lc ${singleQuote(script.replace(/\$HOME/g, `/home/${user}`))}`;
  const params = JSON.stringify({ commands: [wrapped] });
  const send = runner(
    "aws",
    [
      "ssm", "send-command",
      "--profile", options.ssmProfile,
      "--instance-ids", instanceId,
      "--document-name", "AWS-RunShellScript",
      "--parameters", params,
      "--query", "Command.CommandId",
      "--output", "text",
    ],
    { timeoutMs: 60_000 },
  );
  if (send.status !== 0) {
    return { machine: machine.id, ok: false, transport: null, reason: `ssm send-command failed: ${send.stderr.trim().slice(0, 160)}`, packages: {} };
  }
  const commandId = send.stdout.trim();

  for (let attempt = 0; attempt < options.ssmPollAttempts; attempt += 1) {
    const invocation = runner(
      "aws",
      [
        "ssm", "get-command-invocation",
        "--profile", options.ssmProfile,
        "--command-id", commandId,
        "--instance-id", instanceId,
        "--query", "[Status,StandardOutputContent]",
        "--output", "json",
      ],
      { timeoutMs: 60_000 },
    );
    if (invocation.status === 0) {
      try {
        const [status, stdout] = JSON.parse(invocation.stdout) as [string, string];
        if (status === "Success") {
          return { machine: machine.id, ok: true, transport: "ssm", packages: parseInstalled(stdout ?? "") };
        }
        if (status === "Failed" || status === "Cancelled" || status === "TimedOut") {
          return { machine: machine.id, ok: false, transport: null, reason: `ssm command ${status}`, packages: {} };
        }
      } catch {
        /* still pending */
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.ssmPollDelayMs);
  }
  return { machine: machine.id, ok: false, transport: null, reason: "ssm command did not complete in time", packages: {} };
}

/**
 * Probe one machine, trying transports in order of cost: local, then ssh, then
 * SSM. SSM is not a hardcoded machine list — it is a fallback attempted for any
 * machine ssh could not reach, and it simply finds nothing for machines that are
 * not SSM-managed.
 */
export function probeMachine(machine: MachineRef, options: ProbeOptions = {}): FleetProbe {
  const runner = options.runner ?? defaultRunner;
  const scopes = options.scopes ?? ["@hasna", "@hasnaxyz"];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const minPackages = options.minPackages ?? DEFAULT_MIN_PACKAGES;
  const script = installedPackagesScript(scopes);

  /** Never let an empty result pass as a measurement. */
  const accept = (probe: FleetProbe | null): FleetProbe | null => {
    if (!probe?.ok) return probe;
    if (Object.keys(probe.packages).length >= minPackages) return probe;
    return {
      machine: probe.machine,
      ok: false,
      transport: null,
      reason: `${probe.transport} probe returned 0 packages — treating as an unreliable measurement, not as an empty machine`,
      packages: {},
    };
  };

  if (options.localMachineId && machine.id === options.localMachineId) {
    const result = runner("bash", ["-lc", script], { timeoutMs });
    if (result.status === 0) {
      const local = accept({ machine: machine.id, ok: true, transport: "local", packages: parseInstalled(result.stdout) });
      if (local?.ok) return local;
    }
  }

  const viaSsh = accept(probeSsh(machine, script, runner, timeoutMs));
  if (viaSsh?.ok) return viaSsh;

  const user = (machine.sshAddress ?? "").split("@")[0] || "hasna";
  const viaSsm = accept(
    probeSsm(
      machine,
      script,
      runner,
      {
        ssmProfile: options.ssmProfile ?? "hasna-stations",
        ssmPollAttempts: options.ssmPollAttempts ?? 15,
        ssmPollDelayMs: options.ssmPollDelayMs ?? 4000,
      },
      user,
    ),
  );
  if (viaSsm?.ok) return viaSsm;

  return (
    viaSsm ??
    viaSsh ?? { machine: machine.id, ok: false, transport: null, reason: "no usable transport", packages: {} }
  );
}
