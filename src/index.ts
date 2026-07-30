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
  FLEET_SEVERITY,
  SHIP_SEVERITY,
  buildReport,
  classifyPackage,
  compareVersions,
  isShippingRelevantPath,
  isSrcPath,
  mergedButUnshipped,
  parseVersion,
  summarizeFleet,
  type CommitFact,
  type FleetBreakdown,
  type FleetStatus,
  type PackageFacts,
  type ShipGapEntry,
  type ShipGapReport,
  type ShipStatus,
} from "./lib/shipgap.js";
export {
  enumerateOrgRepos,
  fetchBranchManifest,
  fetchCommitsSince,
  fetchRegistryFacts,
  installedPackagesScript,
  loadManifestMachines,
  probeMachine,
  resolveCommitAt,
  type FleetProbe,
  type MachineRef,
  type OrgCompleteness,
  type RegistryFacts,
  type RepoRef,
  type Runner,
} from "./lib/shipgap-sources.js";
export {
  renderTable,
  runShipGap,
  sweepFleet,
  type FleetSweep,
  type ShipGapRunOptions,
} from "./lib/shipgap-run.js";
export {
  GATE_HOOKS,
  GATE_SEVERITY,
  classifyGate,
  gatesNeedingAttention,
  referencedScripts,
  type GateEntry,
  type GateHook,
  type GateStatus,
  type PackageManifestFacts,
  type RepoGateFacts,
} from "./lib/publish-gate.js";
export {
  collectGateFacts,
  findPublishInvocations,
  runPublishGates,
  type GateReport,
  type GateRunOptions,
} from "./lib/publish-gate-run.js";
export { readNpmrcToken } from "./lib/npmrc.js";
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
