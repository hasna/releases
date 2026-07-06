export { VERSION } from "./version.js";
export {
  DEFAULT_DATA_DIR,
  eventsDataDir,
  ledgerDbPath,
  outboxPath,
  resolveDataDir,
} from "./lib/config.js";
export { DuplicateReleaseError, ReleaseLedger } from "./lib/ledger.js";
export {
  buildReleaseDocument,
  deriveAppId,
  parsePackageSpec,
  recordRelease,
  type PackageSpec,
  type RecordReleaseInput,
  type RecordReleaseOptions,
  type RecordReleaseResult,
} from "./lib/record.js";
export {
  EVENT_SOURCE,
  emitReleasePublished,
  releasePublishedData,
  type EmitReleasePublishedOptions,
} from "./lib/events.js";
export {
  buildFanoutTasks,
  dispatchFanoutTasks,
  type CommandRunner,
  type DispatchFanoutOptions,
  type FanoutDispatch,
  type FanoutMode,
  type FanoutResult,
  type FanoutTask,
} from "./lib/fanout.js";
export {
  reconcileReleases,
  type ReconcileEntry,
  type ReconcileOptions,
  type ReconcileReport,
  type ReconcileStatus,
} from "./lib/reconcile.js";
export {
  AppIdSchema,
  EvidencePointerSchema,
  GitShaSchema,
  NpmPackageNameSchema,
  PublishPathSchema,
  RELEASE_SCHEMA_ID,
  ReleaseSchema,
  ResourcePointerSchema,
  SemverSchema,
  parseRelease,
  type EvidencePointer,
  type PublishPath,
  type Release,
  type ReleaseInput,
  type ResourcePointer,
} from "./vendor/contracts.js";
export {
  DISTRIBUTION_EVENT_TYPES,
  RELEASE_PUBLISHED_CONTRACT_SCHEMA,
  validateReleasePublishedData,
  type DistributionEventType,
  type ReleasePublishedData,
} from "./vendor/events-catalog.js";
