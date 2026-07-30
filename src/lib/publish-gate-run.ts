/** Live collection for publish-gate classification. */

import {
  classifyGate,
  gatesNeedingAttention,
  type GateEntry,
  type RepoGateFacts,
} from "./publish-gate.js";
import {
  defaultRunner,
  enumerateOrgRepos,
  type OrgCompleteness,
  type RepoRef,
  type Runner,
} from "./shipgap-sources.js";

function ghText(ref: RepoRef, path: string, runner: Runner): string | null {
  const result = runner("gh", ["api", `repos/${ref.org}/${ref.repo}/contents/${path}`, "--jq", ".content"], {
    timeoutMs: 60_000,
  });
  if (result.status !== 0) return null;
  try {
    return Buffer.from(result.stdout.replace(/\s/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Publish invocations found in CI workflow files, e.g. `npm publish --ignore-scripts`. */
export function findPublishInvocations(ref: RepoRef, runner: Runner): string[] {
  const listing = runner(
    "gh",
    ["api", `repos/${ref.org}/${ref.repo}/contents/.github/workflows`, "--jq", ".[].path"],
    { timeoutMs: 60_000 },
  );
  if (listing.status !== 0) return [];
  const invocations: string[] = [];
  for (const path of listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const body = ghText(ref, path, runner);
    if (!body) continue;
    for (const line of body.split("\n")) {
      if (/\b(npm|bun|pnpm|yarn)\s+publish\b/.test(line)) invocations.push(line.trim());
    }
  }
  return invocations;
}

export function collectGateFacts(ref: RepoRef, runner: Runner = defaultRunner): RepoGateFacts | null {
  const manifestText = ghText(ref, "package.json", runner);
  if (!manifestText) return null;
  let parsed: {
    name?: string;
    version?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    files?: string[];
  };
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return null;
  }

  const gitignoreText = ghText(ref, ".gitignore", runner) ?? "";
  const tracked = runner("gh", ["api", `repos/${ref.org}/${ref.repo}/contents`, "--jq", ".[].name"], {
    timeoutMs: 60_000,
  });

  return {
    org: ref.org,
    repo: ref.repo,
    manifest: {
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      private: parsed.private === true,
      scripts: parsed.scripts ?? {},
      files: parsed.files ?? [],
    },
    gitignore: gitignoreText.split("\n"),
    trackedTopLevel:
      tracked.status === 0 ? tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [],
    publishInvocations: findPublishInvocations(ref, runner),
  };
}

export interface GateReport {
  schema: "hasna-releases.publish-gate.v1";
  generated_at: string;
  inventory: { orgs: string[]; repos_enumerated: number; completeness: OrgCompleteness[] };
  summary: { packages: number; needing_attention: number; by_status: Record<string, number> };
  entries: GateEntry[];
}

export interface GateRunOptions {
  orgs?: string[];
  scopes?: string[];
  only?: string[];
  runner?: Runner;
  onProgress?: (message: string) => void;
}

export async function runPublishGates(options: GateRunOptions = {}): Promise<GateReport> {
  const runner = options.runner ?? defaultRunner;
  const orgs = options.orgs ?? ["hasna", "hasnaxyz"];
  const scopes = options.scopes ?? ["@hasna/", "@hasnaxyz/"];

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

  const entries: GateEntry[] = [];
  for (const ref of selected) {
    const facts = collectGateFacts(ref, runner);
    if (!facts) continue;
    if (!facts.manifest.name || !scopes.some((scope) => facts.manifest.name!.startsWith(scope))) continue;
    entries.push(classifyGate(facts));
  }

  const byStatus: Record<string, number> = {};
  for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;

  return {
    schema: "hasna-releases.publish-gate.v1",
    generated_at: new Date().toISOString(),
    inventory: { orgs, repos_enumerated: repos.length, completeness },
    summary: {
      packages: entries.length,
      needing_attention: gatesNeedingAttention(entries).length,
      by_status: byStatus,
    },
    entries: entries.sort((a, b) => b.severity - a.severity || a.repo.localeCompare(b.repo)),
  };
}
