import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@hasna/events";
import { ledgerDbPath } from "./config.js";
import { ReleaseLedger } from "./ledger.js";
import { emitReleasePublished, type EmitReleasePublishedOptions } from "./events.js";
import { buildFanoutTasks, dispatchFanoutTasks, type CommandRunner, type FanoutResult } from "./fanout.js";
import { parseRelease, type EvidencePointer, type Release, type ResourcePointerInput } from "../vendor/contracts.js";
import type { ReleasePublishedData } from "../vendor/events-catalog.js";

export interface PackageSpec {
  package: string;
  version: string;
}

/** Parse `<pkg>@<ver>` (scoped names supported, e.g. `@hasna/todos@1.2.3`). */
export function parsePackageSpec(spec: string): PackageSpec {
  const at = spec.lastIndexOf("@");
  if (at <= 0) throw new Error(`Invalid package spec (expected <pkg>@<ver>): ${spec}`);
  return { package: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** Derive the default app id slug from an npm package name: `@hasna/todos` → `open-todos`. */
export function deriveAppId(npmName: string): string {
  const bare = npmName.includes("/") ? npmName.split("/").pop()! : npmName;
  const slug = bare.replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug.startsWith("open-") ? slug : `open-${slug}`;
}

export interface RecordReleaseInput {
  package: string;
  version: string;
  gitSha: string;
  publishPath: "skill" | "ci";
  appId?: string;
  publishedAt?: string;
  evidenceUris?: string[];
  changelogRefUri?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordReleaseOptions {
  dataDir?: string;
  ledger?: ReleaseLedger;
  fanout?: boolean;
  fanoutRunner?: CommandRunner;
  fanoutProject?: string;
  events?: EmitReleasePublishedOptions;
}

export interface RecordReleaseResult {
  release: Release;
  event: EventEnvelope<ReleasePublishedData>;
  fanout: FanoutResult | null;
}

/** Normalize a user-supplied timestamp to the upstream Z-only ISO format. */
function normalizeTimestamp(value: string, flag: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${flag} timestamp: ${value}`);
  return parsed.toISOString();
}

export function buildReleaseDocument(input: RecordReleaseInput): Release {
  const now = new Date().toISOString();
  // Evidence kinds come from the upstream `EvidenceKindSchema` enum: caller
  // URIs are "url" evidence; the synthesized CLI receipt pointer is "other".
  const evidenceRefs: EvidencePointer[] = input.evidenceUris?.length
    ? input.evidenceUris.map((uri) => ({ id: `evd-${randomUUID()}`, kind: "url" as const, uri }))
    : [
        {
          id: `evd-${randomUUID()}`,
          kind: "other",
          uri: `https://www.npmjs.com/package/${input.package}/v/${input.version}`,
          summary: `Recorded via releases CLI (${input.publishPath} publish path) at ${now}`,
        },
      ];
  // Upstream `ResourceKindSchema` has no "changelog" kind; a changelog entry is a "document".
  const changelogRef: ResourcePointerInput | undefined = input.changelogRefUri
    ? { kind: "document", id: `changelog:${input.package}@${input.version}`, uri: input.changelogRefUri }
    : undefined;
  return parseRelease({
    schema: "hasna.release.v1",
    id: `rel-${randomUUID()}`,
    createdAt: now,
    appId: input.appId ?? deriveAppId(input.package),
    package: input.package,
    version: input.version,
    gitSha: input.gitSha,
    publishedAt: input.publishedAt ? normalizeTimestamp(input.publishedAt, "--published-at") : now,
    publishPath: input.publishPath,
    ...(changelogRef ? { changelogRef } : {}),
    evidenceRefs,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

/**
 * Record a publish receipt: validate + insert the `hasna.release.v1` document
 * into the ledger, emit `release.published`, and fan out the four standard
 * downstream tasks (changelog publish, fleet update, announce, docs refresh).
 */
export async function recordRelease(
  input: RecordReleaseInput,
  options: RecordReleaseOptions = {},
): Promise<RecordReleaseResult> {
  const ledger = options.ledger ?? new ReleaseLedger(ledgerDbPath(options.dataDir));
  const ownLedger = !options.ledger;
  try {
    const release = ledger.insert(buildReleaseDocument(input));
    const event = await emitReleasePublished(release, { dataDir: options.dataDir, ...options.events });
    const fanout =
      options.fanout === false
        ? null
        : dispatchFanoutTasks(buildFanoutTasks(release), {
            dataDir: options.dataDir,
            runner: options.fanoutRunner,
            project: options.fanoutProject,
          });
    return { release, event, fanout };
  } finally {
    if (ownLedger) ledger.close();
  }
}
