/**
 * Publish-gate classification: what, if anything, is checked before a publish.
 *
 * The ship-gap detector answers "did the merged fix reach the registry and the
 * fleet". This answers the question one step earlier: when a publish DOES
 * happen, is anything verifying that what goes out is correct?
 *
 * Two measured failure shapes, opposite in form and identical in outcome:
 *
 *   - `@hasna/projects` carries `prepublishOnly: bun run typecheck && bun test`.
 *     A gate that cannot pass is not a gate — every release ships with
 *     `--ignore-scripts` to get past it, which disables `prepack` too.
 *   - `@hasnaxyz/infinity` has NO `prepublishOnly`, `prepare` or `prepack` at
 *     all, while `files` lists `dist` and `.gitignore` ignores `dist/`. Publish
 *     from a tree that was never built and npm accepts a tarball with no `dist`.
 *
 * Nothing checked before publish, either way.
 *
 * Everything here is statically decidable from the repository EXCEPT whether a
 * gate actually passes. That is a runtime fact and is only ever reported when
 * the gate was really executed; it is never inferred.
 */

export interface PackageManifestFacts {
  name: string | null;
  version: string | null;
  private: boolean;
  scripts: Record<string, string>;
  /** The `files` allowlist, when present. */
  files: string[];
}

export interface RepoGateFacts {
  org: string;
  repo: string;
  manifest: PackageManifestFacts;
  /** Lines of the repo's `.gitignore`. */
  gitignore: string[];
  /** Top-level entries tracked in git, used to tell "built" from "committed". */
  trackedTopLevel: string[];
  /**
   * Publish invocations found in CI workflows, e.g. `npm publish --ignore-scripts`.
   * Used to detect a gate that exists on paper and is skipped in practice.
   */
  publishInvocations: string[];
  /**
   * Result of actually executing the gate, when it was executed. `null` means
   * not run — which is never the same as "passes".
   */
  execution?: { command: string; exitCode: number; summary: string } | null;
}

/** npm lifecycle hooks that run before a publish and can therefore gate it. */
export const GATE_HOOKS = ["prepublishOnly", "prepack", "prepare"] as const;
export type GateHook = (typeof GATE_HOOKS)[number];

export type GateStatus =
  | "not_a_package"
  | "absent"
  | "unbuildable_artifact"
  | "structurally_unpassable"
  | "bypassed_in_practice"
  | "present_unverified"
  | "present_failing"
  | "present_passing";

export const GATE_SEVERITY: Record<GateStatus, number> = {
  unbuildable_artifact: 5,
  structurally_unpassable: 5,
  bypassed_in_practice: 4,
  absent: 3,
  present_failing: 5,
  present_unverified: 1,
  present_passing: 0,
  not_a_package: 0,
};

export interface GateEntry {
  repo: string;
  packageName: string | null;
  status: GateStatus;
  severity: number;
  /** Which gate hooks are defined, and what they run. */
  hooks: Partial<Record<GateHook, string>>;
  /** `files` entries that will be empty unless something builds them first. */
  unbuiltArtifacts: string[];
  /** Gate commands referencing an npm script that does not exist. */
  danglingScriptRefs: string[];
  /** Publish invocations that skip lifecycle scripts. */
  bypassingInvocations: string[];
  verified: boolean;
  reasons: string[];
}

function isIgnored(path: string, gitignore: string[]): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
  return gitignore.some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return false;
    const pattern = line.replace(/^\//, "").replace(/\/$/, "");
    return pattern === normalized;
  });
}

/** `bun run x`, `npm run x`, `yarn x`, `pnpm run x` -> x */
export function referencedScripts(command: string): string[] {
  const names: string[] = [];
  const re = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([a-zA-Z][\w:.-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const name = match[1];
    // `bun test`, `bun x`, `npm publish` etc. are binaries, not script names —
    // but if a script of the same name exists it IS the script that runs.
    if (name) names.push(name);
  }
  return names;
}

const RESERVED_COMMANDS = new Set(["publish", "install", "ci", "x", "pm", "add", "audit", "exec", "dlx"]);

export function classifyGate(facts: RepoGateFacts): GateEntry {
  const reasons: string[] = [];
  const { manifest } = facts;
  const repo = `${facts.org}/${facts.repo}`;

  if (!manifest.name || !manifest.version || manifest.private) {
    return {
      repo,
      packageName: manifest.name,
      status: "not_a_package",
      severity: 0,
      hooks: {},
      unbuiltArtifacts: [],
      danglingScriptRefs: [],
      bypassingInvocations: [],
      verified: false,
      reasons: ["not a publishable package"],
    };
  }

  const hooks: Partial<Record<GateHook, string>> = {};
  for (const hook of GATE_HOOKS) {
    const command = manifest.scripts[hook];
    if (command) hooks[hook] = command;
  }

  // --- artefacts the tarball promises but nothing produces -------------------
  // A `files` entry that is gitignored and untracked only exists if a build
  // step created it. If no gate hook builds, publishing from a clean clone
  // ships a tarball missing that entry — and npm accepts it silently.
  const buildsSomething = Object.values(hooks).some((command) => /\bbuild\b|\bcompile\b|tsc\b/.test(command));
  const unbuiltArtifacts = manifest.files.filter(
    (entry) =>
      isIgnored(entry, facts.gitignore) &&
      !facts.trackedTopLevel.includes(entry.replace(/\/$/, "")) &&
      !buildsSomething,
  );

  // --- gate commands pointing at scripts that do not exist ------------------
  const danglingScriptRefs: string[] = [];
  for (const command of Object.values(hooks)) {
    for (const name of referencedScripts(command)) {
      if (RESERVED_COMMANDS.has(name)) continue;
      if (manifest.scripts[name] === undefined && !/^(test|start)$/.test(name)) {
        danglingScriptRefs.push(name);
      }
    }
  }

  const bypassingInvocations = facts.publishInvocations.filter((line) =>
    /--ignore-scripts|--no-scripts/.test(line),
  );

  // --- classify, most severe first ------------------------------------------
  if (unbuiltArtifacts.length > 0) {
    reasons.push(
      `files lists ${unbuiltArtifacts.map((entry) => `"${entry}"`).join(", ")}, which .gitignore excludes and no ${GATE_HOOKS.join("/")} builds — a publish from an unbuilt tree ships a tarball without it and npm accepts that silently`,
    );
    return {
      repo,
      packageName: manifest.name,
      status: "unbuildable_artifact",
      severity: GATE_SEVERITY.unbuildable_artifact,
      hooks,
      unbuiltArtifacts,
      danglingScriptRefs,
      bypassingInvocations,
      verified: false,
      reasons,
    };
  }

  if (danglingScriptRefs.length > 0) {
    reasons.push(
      `the publish gate runs ${danglingScriptRefs.map((name) => `"${name}"`).join(", ")}, which is not defined in scripts — the gate can never pass`,
    );
    return {
      repo,
      packageName: manifest.name,
      status: "structurally_unpassable",
      severity: GATE_SEVERITY.structurally_unpassable,
      hooks,
      unbuiltArtifacts,
      danglingScriptRefs,
      bypassingInvocations,
      verified: false,
      reasons,
    };
  }

  if (Object.keys(hooks).length === 0) {
    reasons.push(`no ${GATE_HOOKS.join(", ")} — nothing is checked before a publish`);
    return {
      repo,
      packageName: manifest.name,
      status: "absent",
      severity: GATE_SEVERITY.absent,
      hooks,
      unbuiltArtifacts,
      danglingScriptRefs,
      bypassingInvocations,
      verified: false,
      reasons,
    };
  }

  // A gate that is skipped at the call site is not a gate. Note that
  // `--ignore-scripts` also disables `prepack`, so bypassing the test gate
  // silently stops the build too.
  if (bypassingInvocations.length > 0) {
    reasons.push(
      `a publish gate is defined (${Object.keys(hooks).join(", ")}) but publishes run with --ignore-scripts, which also disables prepack and therefore the build`,
    );
    return {
      repo,
      packageName: manifest.name,
      status: "bypassed_in_practice",
      severity: GATE_SEVERITY.bypassed_in_practice,
      hooks,
      unbuiltArtifacts,
      danglingScriptRefs,
      bypassingInvocations,
      verified: false,
      reasons,
    };
  }

  // Executing the gate is the ONLY way to claim it passes. Absent an execution
  // record, the honest answer is "unverified", never "passing".
  if (facts.execution) {
    const passing = facts.execution.exitCode === 0;
    reasons.push(
      `gate \`${facts.execution.command}\` was executed and exited ${facts.execution.exitCode}: ${facts.execution.summary}`,
    );
    return {
      repo,
      packageName: manifest.name,
      status: passing ? "present_passing" : "present_failing",
      severity: passing ? GATE_SEVERITY.present_passing : GATE_SEVERITY.present_failing,
      hooks,
      unbuiltArtifacts,
      danglingScriptRefs,
      bypassingInvocations,
      verified: true,
      reasons,
    };
  }

  reasons.push(
    `gate present (${Object.keys(hooks).join(", ")}) but not executed — presence is not evidence that it passes`,
  );
  return {
    repo,
    packageName: manifest.name,
    status: "present_unverified",
    severity: GATE_SEVERITY.present_unverified,
    hooks,
    unbuiltArtifacts,
    danglingScriptRefs,
    bypassingInvocations,
    verified: false,
    reasons,
  };
}

export function gatesNeedingAttention(entries: GateEntry[]): GateEntry[] {
  return entries.filter((entry) => entry.severity >= GATE_SEVERITY.absent);
}
