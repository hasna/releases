import { describe, expect, test } from "bun:test";
import {
  EvidenceKindSchema,
  parseRelease,
  ResourceKindSchema,
} from "./contracts.js";
import { buildReleaseDocument } from "../lib/record.js";

// Mirror-parity guard: these fixtures are verbatim copies of
// `examples/release.valid.json` and `examples/release.invalid.json` from
// `@hasna/contracts` (branch `feat/distribution-schemas`). If the vendored
// mirror in ./contracts.ts drifts from the upstream `ReleaseSchema`, these
// tests are the tripwire — update the mirror AND these fixtures together.
const upstreamValidExample = {
  schema: "hasna.release.v1",
  id: "release_open_todos_0_11_63",
  createdAt: "2026-07-06T09:00:00.000Z",
  appId: "open-todos",
  package: "@hasna/todos",
  version: "0.11.63",
  gitSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  publishedAt: "2026-07-06T09:00:00.000Z",
  publishPath: "skill",
  evidenceRefs: [
    {
      id: "ev_publish_open_todos_0_11_63",
      kind: "command_output",
      uri: "artifact://releases/open-todos/0.11.63/publish-output.txt",
      summary: "bun publish output",
    },
  ],
};

const upstreamInvalidExample = {
  schema: "hasna.release.v1",
  id: "release_missing_publish_evidence",
  createdAt: "2026-07-06T09:00:00.000Z",
  appId: "open-todos",
  package: "@hasna/todos",
  version: "0.11.63",
  gitSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  publishedAt: "2026-07-06T09:00:00.000Z",
  publishPath: "skill",
  evidenceRefs: [],
};

// Verbatim copies of the upstream enums (open-contracts `src/schemas.ts`).
const upstreamEvidenceKinds = [
  "file",
  "command_output",
  "screenshot",
  "log",
  "diff",
  "report",
  "artifact",
  "url",
  "video",
  "har",
  "test_result",
  "metric",
  "trace",
  "other",
];
const upstreamResourceKinds = [
  "task",
  "project",
  "repo",
  "run",
  "loop",
  "workflow",
  "action",
  "event",
  "integration",
  "session",
  "machine",
  "model",
  "tool",
  "file",
  "document",
  "url",
  "artifact",
  "knowledge",
  "email",
  "conversation",
  "dashboard",
  "render",
  "panel",
  "report",
  "commit",
  "branch",
  "pull_request",
  "issue",
  "comment",
  "verification",
  "finding",
  "context_pack",
  "proof_bundle",
  "memento",
  "eval",
  "budget",
  "cost",
  "alert",
  "incident",
  "app",
  "release",
  "rollout",
  "announcement",
  "audience",
  "feedback",
  "unknown",
];

describe("upstream hasna.release.v1 parity", () => {
  test("accepts the upstream examples/release.valid.json document", () => {
    const release = parseRelease(upstreamValidExample);
    expect(release.evidenceRefs[0]?.kind).toBe("command_output");
  });

  test("rejects the upstream examples/release.invalid.json document", () => {
    expect(() => parseRelease(upstreamInvalidExample)).toThrow(/evidenceRefs|non-empty/);
  });

  test("mirrored enums match the upstream enum values exactly", () => {
    expect(EvidenceKindSchema.options).toEqual(upstreamEvidenceKinds as never);
    expect(ResourceKindSchema.options).toEqual(upstreamResourceKinds as never);
  });

  test("buildReleaseDocument output only uses upstream-valid kinds and Z-only timestamps", () => {
    const release = buildReleaseDocument({
      package: "@hasna/todos",
      version: "1.4.2",
      gitSha: "0f4c2d1",
      publishPath: "skill",
      publishedAt: "2026-07-06T10:00:00+02:00",
      evidenceUris: ["https://example.com/publish-log"],
      changelogRefUri: "https://example.com/changelog",
    });
    for (const evidence of release.evidenceRefs) {
      expect(upstreamEvidenceKinds).toContain(evidence.kind!);
    }
    expect(upstreamResourceKinds).toContain(release.changelogRef!.kind);
    // Offset timestamps are normalized to the upstream Z-only format.
    expect(release.publishedAt).toBe("2026-07-06T08:00:00.000Z");
    expect(release.createdAt).toMatch(/Z$/);
  });

  test("synthesized default evidence (no --evidence flags) is upstream-valid", () => {
    const release = buildReleaseDocument({
      package: "@hasna/todos",
      version: "1.4.2",
      gitSha: "0f4c2d1",
      publishPath: "ci",
    });
    expect(release.evidenceRefs).toHaveLength(1);
    expect(release.evidenceRefs[0]?.kind).toBe("other");
    // Re-parse round-trip: the stored document is itself contract-valid.
    expect(() => parseRelease(JSON.parse(JSON.stringify(release)))).not.toThrow();
  });
});
