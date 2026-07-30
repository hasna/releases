import { describe, expect, test } from "bun:test";
import {
  classifyGate,
  gatesNeedingAttention,
  referencedScripts,
  type RepoGateFacts,
} from "./publish-gate.js";

function gateFacts(overrides: Partial<RepoGateFacts> = {}): RepoGateFacts {
  return {
    org: "hasna",
    repo: "example",
    manifest: {
      name: "@hasna/example",
      version: "1.0.0",
      private: false,
      scripts: { build: "tsc", test: "bun test", prepack: "bun run build" },
      files: ["dist", "README.md"],
    },
    gitignore: ["node_modules/", "dist/"],
    trackedTopLevel: ["src", "README.md", "package.json"],
    publishInvocations: [],
    ...overrides,
  };
}

describe("script reference extraction", () => {
  test("finds run targets across package managers", () => {
    expect(referencedScripts("bun run typecheck && bun test")).toEqual(["typecheck", "test"]);
    expect(referencedScripts("npm run build")).toEqual(["build"]);
    expect(referencedScripts("pnpm run lint && yarn verify")).toEqual(["lint", "verify"]);
  });

  test("a file path executed directly is not a script name", () => {
    // Measured false positive: `@hasna/accounts` prepublishOnly runs
    // `bun run scripts/release-provenance.ts reject-direct-publish`. Reading
    // "scripts" as a script name reported a working gate as unpassable.
    expect(referencedScripts("bun run scripts/release-provenance.ts reject-direct-publish")).toEqual([]);
    expect(referencedScripts("bun scripts/build.ts")).toEqual([]);
    expect(referencedScripts("bun run verify.ts")).toEqual([]);
  });

  test("a real script name alongside a file path is still found", () => {
    expect(referencedScripts("bun run build && bun run scripts/check.ts")).toEqual(["build"]);
  });
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS — the two instances named in the brief
// ---------------------------------------------------------------------------

describe("positive control — @hasnaxyz/infinity has no publish gate and a gitignored dist", () => {
  // Provenance, all read from the GitHub API on 2026-07-30:
  //   hasnaxyz/iapp-infinity package.json -> name @hasnaxyz/infinity, version 1.0.9,
  //     files ["dist","evidence","migrations","README.md","LICENSE"],
  //     scripts contain build/test/typecheck but NO prepublishOnly, prepare or prepack.
  //   .gitignore line 2 is `dist/`; GET contents/dist returns 404, so it is not tracked.
  const infinity = gateFacts({
    org: "hasnaxyz",
    repo: "iapp-infinity",
    manifest: {
      name: "@hasnaxyz/infinity",
      version: "1.0.9",
      private: false,
      files: ["dist", "evidence", "migrations", "README.md", "LICENSE"],
      scripts: {
        test: "bun test",
        typecheck: "tsc --noEmit",
        build: "bun scripts/build.ts",
        clean: "rm -rf dist",
        pack: "bun pm pack",
      },
    },
    gitignore: ["node_modules/", "dist/", ".env"],
    trackedTopLevel: ["src", "scripts", "tests", "migrations", "README.md", "LICENSE"],
  });

  test("fires as unbuildable_artifact", () => {
    const entry = classifyGate(infinity);
    expect(entry.status).toBe("unbuildable_artifact");
    expect(entry.unbuiltArtifacts).toEqual(["dist"]);
  });

  test("the reason explains that npm accepts the empty tarball silently", () => {
    expect(classifyGate(infinity).reasons.join(" ")).toContain("npm accepts that silently");
  });

  test("a build script existing is not a gate — only a lifecycle hook is", () => {
    // `build` is defined. It is simply never invoked before a publish.
    expect(infinity.manifest.scripts.build).toBeDefined();
    expect(classifyGate(infinity).hooks).toEqual({});
  });

  test("adding prepack to the same manifest clears it", () => {
    const fixed = classifyGate({
      ...infinity,
      manifest: {
        ...infinity.manifest,
        scripts: { ...infinity.manifest.scripts, prepack: "bun run build" },
      },
    });
    expect(fixed.status).not.toBe("unbuildable_artifact");
    expect(fixed.unbuiltArtifacts).toEqual([]);
  });
});

describe("positive control — @hasna/projects ships with the gate skipped", () => {
  // Provenance: hasna/projects package.json on 2026-07-30 ->
  //   prepublishOnly "bun run typecheck && bun test", prepack "bun run build",
  //   files includes "dist", .gitignore includes "dist/".
  // `prepack` builds dist, so the artefact is fine; the defect is that the gate
  // cannot pass and publishes therefore run --ignore-scripts, which ALSO
  // disables prepack and so disables the build.
  const projects = gateFacts({
    repo: "projects",
    manifest: {
      name: "@hasna/projects",
      version: "0.1.96",
      private: false,
      files: ["dist", "migrations", "LICENSE", "README.md"],
      scripts: {
        build: "bun build src/index.ts --outdir dist",
        typecheck: "tsc --noEmit",
        test: "bun test",
        prepack: "bun run build",
        prepublishOnly: "bun run typecheck && bun test",
      },
    },
    gitignore: ["node_modules/", "dist/"],
    trackedTopLevel: ["src", "migrations", "README.md"],
    publishInvocations: ["npm publish --access public --ignore-scripts"],
  });

  test("fires as bypassed_in_practice", () => {
    const entry = classifyGate(projects);
    expect(entry.status).toBe("bypassed_in_practice");
    expect(entry.bypassingInvocations).toEqual(["npm publish --access public --ignore-scripts"]);
  });

  test("the reason names the consequence that prepack dies with it", () => {
    expect(classifyGate(projects).reasons.join(" ")).toContain("also disables prepack");
  });

  test("without the --ignore-scripts publish the same manifest is merely unverified", () => {
    const entry = classifyGate({ ...projects, publishInvocations: ["npm publish --access public"] });
    expect(entry.status).toBe("present_unverified");
  });

  test("executing the gate is what decides pass or fail — presence never is", () => {
    const failing = classifyGate({
      ...projects,
      publishInvocations: [],
      execution: { command: "bun run typecheck && bun test", exitCode: 1, summary: "12 type errors" },
    });
    expect(failing.status).toBe("present_failing");
    expect(failing.verified).toBe(true);

    const passing = classifyGate({
      ...projects,
      publishInvocations: [],
      execution: { command: "bun run typecheck && bun test", exitCode: 0, summary: "clean" },
    });
    expect(passing.status).toBe("present_passing");
    expect(passing.severity).toBe(0);
  });
});

describe("structurally unpassable gates", () => {
  test("a gate calling a script that does not exist can never pass", () => {
    const entry = classifyGate(
      gateFacts({
        manifest: {
          name: "@hasna/example",
          version: "1.0.0",
          private: false,
          files: ["dist"],
          scripts: { build: "tsc", prepack: "bun run build", prepublishOnly: "bun run verify:all" },
        },
      }),
    );
    expect(entry.status).toBe("structurally_unpassable");
    expect(entry.danglingScriptRefs).toEqual(["verify:all"]);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  test("a package with a real gate and a built artefact is not flagged", () => {
    const entry = classifyGate(gateFacts());
    expect(entry.status).toBe("present_unverified");
    expect(entry.severity).toBeLessThan(3);
    expect(gatesNeedingAttention([entry])).toHaveLength(0);
  });

  test("a files entry that is tracked in git needs no build step", () => {
    const entry = classifyGate(
      gateFacts({
        manifest: {
          name: "@hasna/example",
          version: "1.0.0",
          private: false,
          files: ["bin", "README.md"],
          scripts: {},
        },
        gitignore: ["node_modules/"],
        trackedTopLevel: ["bin", "README.md"],
      }),
    );
    expect(entry.unbuiltArtifacts).toEqual([]);
    // Still no gate at all, which is its own finding — but not a missing artefact.
    expect(entry.status).toBe("absent");
  });

  test("a private package is not judged on its publish gate", () => {
    const entry = classifyGate(
      gateFacts({ manifest: { ...gateFacts().manifest, private: true, scripts: {} } }),
    );
    expect(entry.status).toBe("not_a_package");
    expect(entry.severity).toBe(0);
  });

  test("a plain publish invocation is not a bypass", () => {
    const entry = classifyGate(gateFacts({ publishInvocations: ["npm publish --access public"] }));
    expect(entry.bypassingInvocations).toEqual([]);
  });
});
