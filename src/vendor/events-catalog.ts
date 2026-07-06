// Vendored minimal mirror of the typed distribution event catalog from
// `@hasna/events` (branch `feat/distribution-event-catalog`, `./catalog`
// export not published yet). Only the pieces this package emits are
// mirrored: `release.published` and its payload validator.
//
// Once the catalog branch ships, swap these for
// `import { DISTRIBUTION_EVENT_TYPES, validateReleasePublishedData } from "@hasna/events/catalog"`.

export const DISTRIBUTION_EVENT_TYPES = {
  releasePublished: "release.published",
  rolloutStarted: "release.rollout.started",
  rolloutCompleted: "release.rollout.completed",
  rolloutFailed: "release.rollout.failed",
  appInstalled: "app.installed",
  announcementSent: "announcement.sent",
  feedbackCreated: "feedback.created",
  feedbackTriaged: "feedback.triaged",
} as const;

export type DistributionEventType = (typeof DISTRIBUTION_EVENT_TYPES)[keyof typeof DISTRIBUTION_EVENT_TYPES];

/** Contracts schema id the `release.published` payload mirrors. */
export const RELEASE_PUBLISHED_CONTRACT_SCHEMA = "hasna.release.v1" as const;

export type PublishPath = "skill" | "ci" | "backfilled";

/** Payload for `release.published`; mirrors `hasna.release.v1` key fields. Open — extra keys allowed. */
export type ReleasePublishedData = {
  appId: string;
  package: string;
  version: string;
  gitSha?: string;
  publishedAt?: string;
  publishPath?: PublishPath;
  changelogRef?: string;
  [key: string]: unknown;
};

export interface EventValidationIssue {
  path: string;
  message: string;
}

export type EventValidationResult = { ok: true } | { ok: false; issues: EventValidationIssue[] };

const PUBLISH_PATHS: readonly string[] = ["skill", "ci", "backfilled"];

function requireString(data: Record<string, unknown>, key: string, issues: EventValidationIssue[]): void {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: key, message: "must be a non-empty string" });
  }
}

function optionalString(data: Record<string, unknown>, key: string, issues: EventValidationIssue[]): void {
  const value = data[key];
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    issues.push({ path: key, message: "must be a non-empty string when present" });
  }
}

/** Mirror of the catalog's `validateReleasePublishedData` structural validator. */
export function validateReleasePublishedData(data: Record<string, unknown>): EventValidationResult {
  const issues: EventValidationIssue[] = [];
  requireString(data, "appId", issues);
  requireString(data, "package", issues);
  requireString(data, "version", issues);
  optionalString(data, "gitSha", issues);
  optionalString(data, "publishedAt", issues);
  const publishPath = data["publishPath"];
  if (publishPath !== undefined && (typeof publishPath !== "string" || !PUBLISH_PATHS.includes(publishPath))) {
    issues.push({ path: "publishPath", message: `must be one of: ${PUBLISH_PATHS.join(", ")}` });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
