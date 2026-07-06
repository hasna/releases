import { EventsClient, type EventEnvelope } from "@hasna/events";
import { eventsDataDir } from "./config.js";
import type { Release } from "../vendor/contracts.js";
import {
  DISTRIBUTION_EVENT_TYPES,
  validateReleasePublishedData,
  type ReleasePublishedData,
} from "../vendor/events-catalog.js";

export const EVENT_SOURCE = "releases";

export interface EmitReleasePublishedOptions {
  dataDir?: string;
  client?: EventsClient;
}

export function releasePublishedData(release: Release): ReleasePublishedData {
  return {
    appId: release.appId,
    package: release.package,
    version: release.version,
    gitSha: release.gitSha,
    publishedAt: release.publishedAt,
    publishPath: release.publishPath,
    ...(release.changelogRef?.uri ? { changelogRef: release.changelogRef.uri } : {}),
    releaseId: release.id,
  };
}

/**
 * Emit `release.published` (typed distribution event catalog; payload mirrors
 * `hasna.release.v1`) through the `@hasna/events` envelope into the local
 * events store. The payload is checked against the vendored catalog
 * validator before it is emitted.
 */
export async function emitReleasePublished(
  release: Release,
  options: EmitReleasePublishedOptions = {},
): Promise<EventEnvelope<ReleasePublishedData>> {
  const data = releasePublishedData(release);
  const check = validateReleasePublishedData(data);
  if (!check.ok) {
    const detail = check.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`release.published payload failed catalog validation: ${detail}`);
  }
  const client = options.client ?? new EventsClient({ dataDir: eventsDataDir(options.dataDir) });
  const result = await client.emit<ReleasePublishedData>({
    source: EVENT_SOURCE,
    type: DISTRIBUTION_EVENT_TYPES.releasePublished,
    subject: `${release.package}@${release.version}`,
    data,
    message: `Published ${release.package}@${release.version} via ${release.publishPath}`,
    dedupeKey: `release.published:${release.package}@${release.version}`,
  });
  return result.event;
}
