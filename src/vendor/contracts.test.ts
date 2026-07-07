import { describe, expect, test } from "bun:test";
import { parseRelease, ReleaseSchema } from "./contracts.js";

const validRelease = {
  schema: "hasna.release.v1",
  id: "rel-1",
  createdAt: "2026-07-06T10:00:00.000Z",
  appId: "open-todos",
  package: "@hasna/todos",
  version: "1.4.2",
  gitSha: "0f4c2d1",
  publishedAt: "2026-07-06T10:00:00.000Z",
  publishPath: "skill",
  evidenceRefs: [{ id: "evd-1", kind: "url", uri: "https://example.com/publish-log" }],
};

describe("hasna.release.v1 vendored mirror", () => {
  test("accepts a valid release document", () => {
    const release = parseRelease(validRelease);
    expect(release.package).toBe("@hasna/todos");
    expect(release.publishPath).toBe("skill");
  });

  test("rejects unknown keys (strict)", () => {
    expect(() => parseRelease({ ...validRelease, extra: true })).toThrow();
  });

  test("requires non-empty evidenceRefs unless backfilled", () => {
    expect(() => parseRelease({ ...validRelease, evidenceRefs: [] })).toThrow(/evidenceRefs|non-empty/);
    const backfilled = parseRelease({ ...validRelease, publishPath: "backfilled", evidenceRefs: [] });
    expect(backfilled.evidenceRefs).toEqual([]);
  });

  test("evidenceRefs defaults to [] for backfilled", () => {
    const { evidenceRefs: _omit, ...rest } = validRelease;
    const parsed = ReleaseSchema.parse({ ...rest, publishPath: "backfilled" });
    expect(parsed.evidenceRefs).toEqual([]);
  });

  test("rejects bad appId, semver, and git sha", () => {
    expect(() => parseRelease({ ...validRelease, appId: "Open Todos" })).toThrow();
    expect(() => parseRelease({ ...validRelease, version: "1.4" })).toThrow();
    expect(() => parseRelease({ ...validRelease, gitSha: "xyz" })).toThrow();
  });

  test("rejects evidence kinds outside the upstream EvidenceKindSchema enum", () => {
    for (const kind of ["uri", "cli-record", "npm-registry"]) {
      expect(() =>
        parseRelease({ ...validRelease, evidenceRefs: [{ id: "evd-1", kind, uri: "https://example.com/log" }] }),
      ).toThrow();
    }
  });

  test("rejects timestamps with UTC offsets (upstream TimestampSchema is Z-only)", () => {
    expect(() => parseRelease({ ...validRelease, publishedAt: "2026-07-06T10:00:00+02:00" })).toThrow();
    expect(() => parseRelease({ ...validRelease, createdAt: "2026-07-06T10:00:00+02:00" })).toThrow();
  });

  test("rejects evidence URIs with schemes outside the upstream UriSchema allowlist", () => {
    expect(() =>
      parseRelease({ ...validRelease, evidenceRefs: [{ id: "evd-1", kind: "url", uri: "ftp://example.com/log" }] }),
    ).toThrow();
  });

  test("changelogRef is optional (deferred refs are legal)", () => {
    const parsed = parseRelease({
      ...validRelease,
      changelogRef: { kind: "document", id: "changelog:@hasna/todos@1.4.2", uri: "https://example.com/changelog" },
    });
    expect(parsed.changelogRef?.kind).toBe("document");
  });

  test('rejects the non-upstream "changelog" resource kind', () => {
    expect(() =>
      parseRelease({
        ...validRelease,
        changelogRef: { kind: "changelog", id: "changelog:@hasna/todos@1.4.2", uri: "https://example.com/changelog" },
      }),
    ).toThrow();
  });

  test("changelogRef without a uri requires both sourcePackage and externalId", () => {
    expect(() =>
      parseRelease({
        ...validRelease,
        changelogRef: { kind: "document", id: "changelog:x", externalId: "entry-1" },
      }),
    ).toThrow(/sourcePackage/);
    const parsed = parseRelease({
      ...validRelease,
      changelogRef: { kind: "document", id: "changelog:x", externalId: "entry-1", sourcePackage: "@hasna/changelog" },
    });
    expect(parsed.changelogRef?.externalId).toBe("entry-1");
  });
});
