// Vendored structural mirror of the `hasna.release.v1` contract from
// `@hasna/contracts` (branch `feat/distribution-schemas`, not published yet).
//
// Keep this file in sync with the upstream schema (`src/schemas.ts` on that
// branch). The `TimestampSchema`, `UriSchema`, `EvidenceKindSchema`, and
// `ResourceKindSchema` mirrors below are copied verbatim from upstream so that
// every document this package writes is valid against the real contract.
// Once `@hasna/contracts` ships the distribution schemas, this mirror can be
// replaced with `parseContract(SCHEMA_IDS.release, value)` from the real
// package.
import { z } from "zod";

export const RELEASE_SCHEMA_ID = "hasna.release.v1" as const;

/** Mirrors upstream `TimestampSchema` (Z-only ISO datetimes, no offsets). */
export const TimestampSchema = z.string().datetime();
export const OptionalTimestampSchema = TimestampSchema.nullable().optional();

const NonEmptyStringSchema = z.string().trim().min(1);

/** Mirrors upstream `UriSchema` (allowed URI scheme prefixes). */
export const UriSchema = NonEmptyStringSchema.refine(
  (value) =>
    value.startsWith("artifact://") ||
    value.startsWith("repo://") ||
    value.startsWith("project://") ||
    value.startsWith("dashboard://") ||
    value.startsWith("render://") ||
    value.startsWith("integration://") ||
    value.startsWith("task://") ||
    value.startsWith("todo://") ||
    value.startsWith("file://") ||
    value.startsWith("files://") ||
    value.startsWith("mailery://") ||
    value.startsWith("conversation://") ||
    value.startsWith("knowledge://") ||
    value.startsWith("memento://") ||
    value.startsWith("https://") ||
    value.startsWith("http://") ||
    value.startsWith("git+https://"),
  "URI must use artifact://, repo://, project://, dashboard://, render://, integration://, task://, todo://, file://, files://, mailery://, conversation://, knowledge://, memento://, http(s)://, or git+https://",
);

/** Mirrors upstream `Sha256DigestSchema`. */
export const Sha256DigestSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);

/** Mirrors upstream `TagsSchema`. */
export const TagsSchema = z.array(z.string().min(1)).default([]);

/** App id slug, e.g. `open-todos`. Mirrors `AppIdSchema`. */
export const AppIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case slug");

/** Mirrors `NpmPackageNameSchema`. */
export const NpmPackageNameSchema = z
  .string()
  .regex(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, "must be a valid npm package name");

/** Mirrors `SemverSchema`. */
export const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    "must be a semver version",
  );

/** Mirrors `GitShaSchema`. */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, "must be a 7-40 char lowercase hex git sha");

export const PublishPathSchema = z.enum(["skill", "ci", "backfilled"]);
export type PublishPath = z.infer<typeof PublishPathSchema>;

/** Mirrors upstream `ResourceKindSchema` (verbatim enum copy). */
export const ResourceKindSchema = z.enum([
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
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** Mirrors upstream `EvidenceKindSchema` (verbatim enum copy). */
export const EvidenceKindSchema = z.enum([
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
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** Mirrors `EvidencePointer`. */
export const EvidencePointerSchema = z
  .object({
    id: z.string().min(1),
    kind: EvidenceKindSchema.optional(),
    uri: UriSchema.optional(),
    sha256: Sha256DigestSchema.optional(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

/** Mirrors `ResourcePointer` (used for deferred `changelogRef`). */
export const ResourcePointerSchema = z
  .object({
    kind: ResourceKindSchema,
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    uri: UriSchema.optional(),
    externalId: NonEmptyStringSchema.optional(),
    sourcePackage: NonEmptyStringSchema.optional(),
    tags: TagsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.uri && Boolean(value.externalId) !== Boolean(value.sourcePackage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Resource pointers with external package locators require both sourcePackage and externalId",
        path: value.externalId ? ["sourcePackage"] : ["externalId"],
      });
    }
  });
export type ResourcePointer = z.infer<typeof ResourcePointerSchema>;
export type ResourcePointerInput = z.input<typeof ResourcePointerSchema>;

/**
 * Mirrors `hasna.release.v1` (`ReleaseSchema`): contract base + release
 * fields. Documents are `.strict()` — unknown keys are rejected.
 * RULE: `evidenceRefs` must be non-empty unless `publishPath === "backfilled"`.
 */
export const ReleaseSchema = z
  .object({
    schema: z.literal(RELEASE_SCHEMA_ID),
    id: z.string().min(1),
    createdAt: TimestampSchema,
    updatedAt: OptionalTimestampSchema,
    metadata: z.record(z.unknown()).optional(),
    appId: AppIdSchema,
    package: NpmPackageNameSchema,
    version: SemverSchema,
    gitSha: GitShaSchema,
    publishedAt: TimestampSchema,
    publishPath: PublishPathSchema,
    changelogRef: ResourcePointerSchema.optional(),
    evidenceRefs: z.array(EvidencePointerSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.publishPath !== "backfilled" && value.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceRefs"],
        message: 'must be non-empty unless publishPath === "backfilled"',
      });
    }
  });

export type Release = z.infer<typeof ReleaseSchema>;
export type ReleaseInput = z.input<typeof ReleaseSchema>;

/** Parse + validate a `hasna.release.v1` document; throws ZodError on failure. */
export function parseRelease(value: unknown): Release {
  return ReleaseSchema.parse(value);
}
