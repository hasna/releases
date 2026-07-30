import { describe, expect, test } from "bun:test";
import {
  buildReport,
  classifyPackage,
  compareVersions,
  isShippingRelevantPath,
  mergedButUnshipped,
  parseVersion,
  shouldFailGate,
  summarizeFleet,
  unmeasuredPackages,
  type PackageFacts,
} from "./shipgap.js";

function facts(overrides: Partial<PackageFacts> = {}): PackageFacts {
  return {
    org: "hasna",
    repo: "example",
    defaultBranch: "main",
    packageName: "@hasna/example",
    branchVersion: "1.0.0",
    branchPrivate: false,
    registryStatus: "found",
    registryLatest: "1.0.0",
    registryLatestPublishedAt: "2026-07-01T00:00:00.000Z",
    registryVersions: ["1.0.0"],
    commitsSincePublish: [],
    commitsStatus: "measured",
    installed: {},
    unreachable: {},
    ...overrides,
  };
}

describe("semver comparison", () => {
  test("orders release tuples", () => {
    expect(compareVersions("0.1.96", "0.1.95")).toBeGreaterThan(0);
    expect(compareVersions("0.1.89", "0.1.96")).toBeLessThan(0);
    expect(compareVersions("0.5.2", "0.5.2")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  test("does not compare 0.1.9 above 0.1.89 like a string sort would", () => {
    expect(compareVersions("0.1.9", "0.1.89")).toBeLessThan(0);
  });

  test("a release outranks its own prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
  });

  test("unparseable versions sort last rather than throwing", () => {
    expect(parseVersion("not-a-version")).toBeNull();
    expect(compareVersions("not-a-version", "1.0.0")).toBeGreaterThan(0);
  });
});

describe("shipping-relevant paths", () => {
  test("prose and CI wiring cannot change what a consumer runs", () => {
    expect(isShippingRelevantPath("README.md")).toBe(false);
    expect(isShippingRelevantPath("CHANGELOG.md")).toBe(false);
    expect(isShippingRelevantPath("docs/instructions.md")).toBe(false);
    expect(isShippingRelevantPath(".github/workflows/ci.yml")).toBe(false);
    expect(isShippingRelevantPath("LICENSE")).toBe(false);
  });

  test("source, scripts, tests and manifest all count", () => {
    expect(isShippingRelevantPath("src/index.ts")).toBe(true);
    expect(isShippingRelevantPath("scripts/scan-artifact.ts")).toBe(true);
    expect(isShippingRelevantPath("tests/npm-visibility.test.ts")).toBe(true);
    expect(isShippingRelevantPath("package.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS
//
// Three real incidents measured on 2026-07-30. Each fixture is transcribed from
// the GitHub and npm registry APIs; the provenance of every field is cited so a
// reviewer can re-derive it. A detector that has never fired has not been shown
// to work.
// ---------------------------------------------------------------------------

describe("positive control 1 — @hasna/projects, five days of a merged fix nobody shipped", () => {
  // Provenance:
  //   gh pr view 41 --repo hasna/projects  -> merged 2026-07-26T16:12:35Z,
  //     sha bde15ed6318c08f294919148920186efb23a6303, touching src/lib/project-channel.ts
  //     and its regression test src/lib/project-channel.test.ts.
  //   registry.npmjs.org/@hasna%2Fprojects -> 0.1.95 published 2026-07-24T20:54:34.923Z,
  //     next publish 0.1.96 at 2026-07-30T12:28:53.815Z.
  // As-of instant: 2026-07-29T00:00:00Z, i.e. three days after the merge and
  // before anyone noticed.
  const projects = facts({
    repo: "projects",
    packageName: "@hasna/projects",
    branchVersion: "0.1.95",
    registryLatest: "0.1.95",
    registryLatestPublishedAt: "2026-07-24T20:54:34.923Z",
    registryVersions: ["0.1.89", "0.1.92", "0.1.93", "0.1.94", "0.1.95"],
    commitsSincePublish: [
      {
        sha: "bde15ed6318c08f294919148920186efb23a6303",
        committedAt: "2026-07-26T16:12:35Z",
        message: "fix(channel): stop imposing a channel-name prefix the CLI invented",
        paths: [
          "CHANGELOG.md",
          "README.md",
          "src/lib/project-channel.ts",
          "src/lib/project-channel.test.ts",
          "src/store/project-store.ts",
        ],
      },
    ],
    installed: {
      station01: "0.1.89",
      station02: "0.1.89",
      station03: "0.1.89",
    },
  });

  test("fires as unshipped_changes", () => {
    const entry = classifyPackage(projects);
    expect(entry.shipStatus).toBe("unshipped_changes");
    expect(entry.srcCommitsSincePublish).toBe(1);
    expect(entry.shippingCommitsSincePublish).toBe(1);
    expect(entry.latestUnshippedSha).toBe("bde15ed6318c08f294919148920186efb23a6303");
  });

  test("counts toward merged-but-unshipped", () => {
    expect(mergedButUnshipped([classifyPackage(projects)])).toHaveLength(1);
  });

  test("separately reports the fleet as uniformly stale on 0.1.89", () => {
    const entry = classifyPackage(projects);
    expect(entry.fleetStatus).toBe("uniformly_stale");
    expect(entry.fleet.distinctVersions).toEqual(["0.1.89"]);
    expect(entry.fleet.stale).toBe(3);
  });

  test("the version-equal case is exactly what a naive branch-vs-npm diff misses", () => {
    const entry = classifyPackage(projects);
    // Branch and registry agree. Only the commit evidence distinguishes this
    // from a healthy package, which is why (c) cannot be inferred from (b).
    expect(entry.branchVersion).toBe(entry.registryLatest);
    expect(entry.severity).toBeGreaterThan(0);
  });
});

describe("positive control 2 — @hasna/identities, a non-overridable rule that reached zero agents", () => {
  // Provenance:
  //   gh pr view 53 --repo hasna/identities -> merged 2026-07-30T11:09:44Z,
  //     sha 6a8441bda151b4a0aa315a3e0eab6c29abf4943e, touching src/global-agent-rules.ts.
  //   package.json version at that merge sha AND at its parent 6254ea75 is 0.5.2
  //     in both — the merge carried no bump.
  //   registry -> 0.5.2 published 2026-07-29T12:13:11.381Z; 0.5.3 only at
  //     2026-07-30T11:40:45.538Z, 31 minutes after the merge.
  // As-of instant: 2026-07-30T11:20:00Z, inside that 31-minute window.
  const identities = facts({
    repo: "identities",
    packageName: "@hasna/identities",
    branchVersion: "0.5.2",
    registryLatest: "0.5.2",
    registryLatestPublishedAt: "2026-07-29T12:13:11.381Z",
    registryVersions: ["0.5.0", "0.5.1", "0.5.2"],
    commitsSincePublish: [
      {
        sha: "6a8441bda151b4a0aa315a3e0eab6c29abf4943e",
        committedAt: "2026-07-30T11:09:44Z",
        message: "feat(global-rules): rule 21 for the canonical project store",
        paths: [
          "CHANGELOG.md",
          "README.md",
          "docs/instructions.md",
          "src/global-agent-rules.ts",
          "src/index.test.ts",
          "types/global-agent-rules.d.ts",
        ],
      },
    ],
    installed: { station01: "0.5.2", station02: "0.5.2" },
  });

  test("fires as unshipped_changes", () => {
    const entry = classifyPackage(identities);
    expect(entry.shipStatus).toBe("unshipped_changes");
    expect(entry.srcCommitsSincePublish).toBe(1);
  });

  test("the reason names the merge instant and the stale published version", () => {
    const entry = classifyPackage(identities);
    expect(entry.reasons.join(" ")).toContain("0.5.2");
    expect(entry.reasons.join(" ")).toContain("2026-07-29T12:13:11.381Z");
  });

  test("would still have fired had the docs-only files been the whole change", () => {
    // Guard against the opposite error: a rules change that touches only prose
    // is genuinely not a code ship gap, and must not be reported as one.
    const docsOnly = classifyPackage({
      ...identities,
      commitsSincePublish: [
        {
          sha: "deadbeef",
          committedAt: "2026-07-30T11:09:44Z",
          paths: ["README.md", "docs/instructions.md", "CHANGELOG.md"],
        },
      ],
    });
    expect(docsOnly.shipStatus).toBe("shipped");
  });
});

describe("positive control 3 — @hasnaxyz/factory #110, the case an src/-only rule misses", () => {
  // Provenance:
  //   gh pr view 110 --repo hasnaxyz/iapp-factory -> merged 2026-07-30T10:55:50Z,
  //     sha 86338dc6ed592868d8d2e66fbb7c89756f5ab7d5, files exactly:
  //     package.json, scripts/scan-artifact.ts, tests/npm-visibility.test.ts.
  //     NOT ONE FILE UNDER src/.
  //   package.json at the parent had publishConfig.access "public" and no
  //     private flag; after the merge, private:true and access "restricted".
  //     Version unchanged at 0.6.0 across the merge.
  //   registry -> @hasnaxyz/factory 0.6.0 published 2026-07-28T13:02:08.656Z.
  const factory = facts({
    org: "hasnaxyz",
    repo: "iapp-factory",
    packageName: "@hasnaxyz/factory",
    branchVersion: "0.6.0",
    branchPrivate: true,
    registryLatest: "0.6.0",
    registryLatestPublishedAt: "2026-07-28T13:02:08.656Z",
    registryVersions: ["0.5.2", "0.6.0"],
    commitsSincePublish: [
      {
        sha: "86338dc6ed592868d8d2e66fbb7c89756f5ab7d5",
        committedAt: "2026-07-30T10:55:50Z",
        message: "fix(security): @hasnaxyz/factory must refuse to publish publicly (Tier 1 only)",
        paths: ["package.json", "scripts/scan-artifact.ts", "tests/npm-visibility.test.ts"],
      },
    ],
    installed: { station01: "0.6.0" },
  });

  test("fires as unshipped_changes even though no src/ file changed", () => {
    const entry = classifyPackage(factory);
    expect(entry.shipStatus).toBe("unshipped_changes");
    expect(entry.srcCommitsSincePublish).toBe(0);
    expect(entry.shippingCommitsSincePublish).toBe(1);
  });

  test("a strict src/-only rule would have reported this repo clean — regression guard", () => {
    const srcOnlyWouldSee = factory.commitsSincePublish.filter((commit) =>
      commit.paths.some((path) => path.startsWith("src/")),
    );
    expect(srcOnlyWouldSee).toHaveLength(0);
    // ...and yet:
    expect(classifyPackage(factory).shipStatus).toBe("unshipped_changes");
  });

  test("private:true while the name is on the registry is called out, not silently skipped", () => {
    const entry = classifyPackage(factory);
    expect(entry.reasons.join(" ")).toContain("private:true");
    expect(entry.shipStatus).not.toBe("not_a_package");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS
// ---------------------------------------------------------------------------

describe("negative controls — a detector that flags everything is as useless as one that flags nothing", () => {
  test("a genuinely current package is not flagged on either axis", () => {
    const entry = classifyPackage(
      facts({
        repo: "accounts",
        packageName: "@hasna/accounts",
        branchVersion: "0.2.24",
        registryLatest: "0.2.24",
        registryVersions: ["0.2.23", "0.2.24"],
        commitsSincePublish: [],
        installed: { station01: "0.2.24", station02: "0.2.24", station03: "0.2.24" },
      }),
    );
    expect(entry.shipStatus).toBe("shipped");
    expect(entry.fleetStatus).toBe("current");
    expect(entry.severity).toBe(0);
    expect(mergedButUnshipped([entry])).toHaveLength(0);
  });

  test("docs-only commits after a publish do not create a ship gap", () => {
    const entry = classifyPackage(
      facts({
        commitsSincePublish: [
          { sha: "aaa", committedAt: "2026-07-05T00:00:00Z", paths: ["README.md"] },
          { sha: "bbb", committedAt: "2026-07-06T00:00:00Z", paths: [".github/workflows/ci.yml"] },
        ],
        installed: { station01: "1.0.0" },
      }),
    );
    expect(entry.shipStatus).toBe("shipped");
  });

  test("a repo with no package.json is not a package and is not flagged", () => {
    const entry = classifyPackage(facts({ packageName: null, branchVersion: null, registryStatus: "absent", registryLatest: null }));
    expect(entry.shipStatus).toBe("not_a_package");
    expect(entry.fleetStatus).toBe("not_applicable");
    expect(entry.severity).toBe(0);
  });

  test("a private package that was never published is not flagged as never_published", () => {
    const entry = classifyPackage(
      facts({ branchPrivate: true, registryStatus: "absent", registryLatest: null, registryLatestPublishedAt: null, registryVersions: [] }),
    );
    expect(entry.shipStatus).toBe("not_a_package");
  });
});

// ---------------------------------------------------------------------------
// the other ship statuses
// ---------------------------------------------------------------------------

describe("ship statuses", () => {
  test("a merged bump that was never published is behind_publish", () => {
    const entry = classifyPackage(
      facts({ branchVersion: "1.1.0", registryLatest: "1.0.0", registryVersions: ["1.0.0"] }),
    );
    expect(entry.shipStatus).toBe("behind_publish");
    expect(mergedButUnshipped([entry])).toHaveLength(1);
  });

  test("a publishable package absent from the registry is never_published", () => {
    const entry = classifyPackage(
      facts({ registryStatus: "absent", registryLatest: null, registryLatestPublishedAt: null, registryVersions: [] }),
    );
    expect(entry.shipStatus).toBe("never_published");
  });

  test("a registry ahead of the branch is reported, not ignored", () => {
    const entry = classifyPackage(
      facts({ branchVersion: "1.0.0", registryLatest: "1.2.0", registryVersions: ["1.0.0", "1.2.0"] }),
    );
    expect(entry.shipStatus).toBe("registry_ahead");
    // Not a merged-but-unshipped case: the registry has MORE, not less.
    expect(mergedButUnshipped([entry])).toHaveLength(0);
  });

  test("never_published is excluded from the merged-but-unshipped count", () => {
    const entry = classifyPackage(
      facts({ registryStatus: "absent", registryLatest: null, registryLatestPublishedAt: null, registryVersions: [] }),
    );
    expect(entry.shipStatus).toBe("never_published");
    expect(mergedButUnshipped([entry])).toHaveLength(0);
    // Not unmeasured either: the registry answered, and its answer was "no".
    expect(unmeasuredPackages([entry])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE UNMEASURED AXES
//
// Three axes can each fail to be read. All three must say so. The commit axis
// was the one that did not: it answered `shipped`, severity 0, for a package
// whose history it could not see — this detector's own failure mode, inside the
// detector.
// ---------------------------------------------------------------------------

describe("an axis that could not be read never reports clean", () => {
  test("commits_unknown fires when the history could not be read", () => {
    const entry = classifyPackage(
      facts({
        commitsStatus: "unknown",
        commitsError: "gh api rate limit exceeded",
        commitsSincePublish: [],
      }),
    );
    expect(entry.shipStatus).toBe("commits_unknown");
    expect(entry.severity).toBeGreaterThan(0);
    expect(entry.reasons.join(" ")).toContain("UNMEASURED");
    expect(entry.reasons.join(" ")).toContain("gh api rate limit exceeded");
  });

  test("the same facts with a readable history DO report shipped — the state is not sticky", () => {
    const entry = classifyPackage(facts({ commitsStatus: "measured", commitsSincePublish: [] }));
    expect(entry.shipStatus).toBe("shipped");
    expect(entry.severity).toBe(0);
  });

  test("an unreadable history is NOT counted as merged-but-unshipped — it is counted as unmeasured", () => {
    const entry = classifyPackage(facts({ commitsStatus: "unknown" }));
    expect(mergedButUnshipped([entry])).toHaveLength(0);
    expect(unmeasuredPackages([entry])).toHaveLength(1);
  });

  test("registry_unknown behaves the same way on both counts", () => {
    const entry = classifyPackage(
      facts({ registryStatus: "unknown", registryError: "registry 402", registryLatest: null }),
    );
    expect(entry.shipStatus).toBe("registry_unknown");
    expect(entry.severity).toBeGreaterThan(0);
    expect(mergedButUnshipped([entry])).toHaveLength(0);
    expect(unmeasuredPackages([entry])).toHaveLength(1);
  });

  test("commits are only consulted once branch and registry agree", () => {
    // A version mismatch is decisive on its own; an unreadable history must not
    // downgrade a KNOWN behind_publish into an unknown.
    const entry = classifyPackage(
      facts({ branchVersion: "2.0.0", registryLatest: "1.0.0", commitsStatus: "unknown" }),
    );
    expect(entry.shipStatus).toBe("behind_publish");
    expect(mergedButUnshipped([entry])).toHaveLength(1);
  });
});

describe("--fail-on-gap must not exit 0 on a blind sweep", () => {
  const meta = {
    as_of: null,
    inventory: { orgs: ["hasna"], repos_enumerated: 1, completeness: [] },
    fleet: { machines_in_manifest: 18, measured: [], unreachable: [] },
  };

  test("a sweep that found no gaps because it could read nothing FAILS the gate", () => {
    const blind = buildReport([classifyPackage(facts({ commitsStatus: "unknown" }))], meta);
    expect(blind.summary.merged_but_unshipped).toBe(0);
    expect(blind.summary.unmeasured).toBe(1);
    // Zero gaps found, and yet: not good news.
    expect(shouldFailGate(blind)).toBe(true);
  });

  test("a registry-blind sweep also fails the gate", () => {
    const blind = buildReport(
      [classifyPackage(facts({ registryStatus: "unknown", registryLatest: null }))],
      meta,
    );
    expect(shouldFailGate(blind)).toBe(true);
  });

  test("a genuinely clean, fully measured sweep passes the gate", () => {
    const clean = buildReport(
      [classifyPackage(facts({ commitsStatus: "measured", installed: { station01: "1.0.0" } }))],
      meta,
    );
    expect(clean.summary.merged_but_unshipped).toBe(0);
    expect(clean.summary.unmeasured).toBe(0);
    expect(shouldFailGate(clean)).toBe(false);
  });

  test("a real gap still fails the gate", () => {
    const gap = buildReport([classifyPackage(facts({ branchVersion: "2.0.0" }))], meta);
    expect(shouldFailGate(gap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the fleet axis — the systemic gap
// ---------------------------------------------------------------------------

describe("fleet statuses", () => {
  test("published but installed nowhere", () => {
    const entry = classifyPackage(facts({ installed: { station01: null, station02: null } }));
    expect(entry.fleetStatus).toBe("absent_everywhere");
    expect(entry.fleet.missingOn).toEqual(["station01", "station02"]);
  });

  test("installed on some machines and absent on others", () => {
    const entry = classifyPackage(
      facts({ installed: { station01: "1.0.0", station02: null, station03: "1.0.0" } }),
    );
    expect(entry.fleetStatus).toBe("partial_rollout");
    expect(entry.fleet.installed).toBe(2);
    expect(entry.fleet.missingOn).toEqual(["station02"]);
  });

  test("installed everywhere at differing versions", () => {
    const entry = classifyPackage(
      facts({
        registryLatest: "0.1.96",
        branchVersion: "0.1.96",
        installed: { station01: "0.1.96", station02: "0.1.89", station03: "0.1.95" },
      }),
    );
    expect(entry.fleetStatus).toBe("version_skew");
    expect(entry.fleet.distinctVersions).toEqual(["0.1.89", "0.1.95", "0.1.96"]);
    expect(entry.fleet.stale).toBe(2);
    expect(entry.fleet.atLatest).toBe(1);
  });

  test("the measured @hasna/projects rollout shape: 12 machines seven releases behind", () => {
    const installed: Record<string, string> = {};
    for (let i = 1; i <= 12; i += 1) installed[`station${String(i).padStart(2, "0")}`] = "0.1.89";
    installed.station17 = "0.1.95";
    installed.station18 = "0.1.95";
    const entry = classifyPackage(
      facts({
        packageName: "@hasna/projects",
        branchVersion: "0.1.96",
        registryLatest: "0.1.96",
        registryVersions: ["0.1.89", "0.1.95", "0.1.96"],
        installed,
      }),
    );
    expect(entry.fleetStatus).toBe("version_skew");
    expect(entry.fleet.stale).toBe(14);
    expect(entry.fleet.atLatest).toBe(0);
    // Publishing correctly still reached nobody.
    expect(entry.shipStatus).toBe("shipped");
    expect(entry.severity).toBeGreaterThan(0);
  });

  test("unreachable machines are carried through, never silently dropped", () => {
    const entry = classifyPackage(
      facts({
        installed: { station01: "1.0.0" },
        unreachable: { station05: "offline, last seen 9d ago", station04: "tcp/22 timeout" },
      }),
    );
    expect(entry.fleet.unreachable).toEqual(["station04", "station05"]);
    expect(entry.fleet.measured).toBe(1);
  });

  test("summarizeFleet handles a package installed nowhere and measured nowhere", () => {
    const breakdown = summarizeFleet({}, ["station04"], "1.0.0");
    expect(breakdown.measured).toBe(0);
    expect(breakdown.unreachable).toEqual(["station04"]);
  });
});

describe("report", () => {
  test("sorts by severity and counts the number that matters", () => {
    const entries = [
      classifyPackage(facts({ repo: "clean", installed: { station01: "1.0.0" } })),
      classifyPackage(
        facts({ repo: "bumped", branchVersion: "2.0.0", installed: { station01: "1.0.0" } }),
      ),
      classifyPackage(
        facts({
          repo: "unshipped",
          commitsSincePublish: [{ sha: "c1", committedAt: "2026-07-02T00:00:00Z", paths: ["src/a.ts"] }],
          installed: { station01: "1.0.0" },
        }),
      ),
    ];
    const report = buildReport(entries, {
      as_of: null,
      inventory: {
        orgs: ["hasna"],
        repos_enumerated: 3,
        completeness: [{ org: "hasna", enumerated: 3, org_reports: 3, complete: true }],
      },
      fleet: { machines_in_manifest: 18, measured: ["station01"], unreachable: [] },
    });
    expect(report.summary.merged_but_unshipped).toBe(2);
    expect(report.entries[0]?.repo).toBe("hasna/unshipped");
    expect(report.summary.by_ship_status.shipped).toBe(1);
  });
});
