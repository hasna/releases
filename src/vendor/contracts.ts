// Vendored structural mirror of the `hasna.release.v1` contract from
// `@hasna/contracts` (branch `feat/distribution-schemas`, not published yet).
//
// Keep this file in sync with the upstream schema. Once `@hasna/contracts`
// ships the distribution schemas, this mirror can be replaced with
// `parseContract(SCHEMA_IDS.release, value)` from the real package.
import { z } from "zod";

export const RELEASE_SCHEMA_ID = "hasna.release.v1" as const;

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

/** Mirrors `EvidencePointer`. */
export const EvidencePointerSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

/** Minimal mirror of `ResourcePointer` (used for deferred `changelogRef`). */
export const ResourcePointerSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    sourcePackage: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type ResourcePointer = z.infer<typeof ResourcePointerSchema>;

/**
 * Mirrors `hasna.release.v1` (`ReleaseSchema`): contract base + release
 * fields. Documents are `.strict()` — unknown keys are rejected.
 * RULE: `evidenceRefs` must be non-empty unless `publishPath === "backfilled"`.
 */
export const ReleaseSchema = z
  .object({
    schema: z.literal(RELEASE_SCHEMA_ID),
    id: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    appId: AppIdSchema,
    package: NpmPackageNameSchema,
    version: SemverSchema,
    gitSha: GitShaSchema,
    publishedAt: z.string().datetime({ offset: true }),
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
