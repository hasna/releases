# @hasna/releases

Release ledger, publish receipts, downstream fan-out, and npm reconciliation for Hasna-coded apps.

Part of the Hasna distribution apps plan: every publish of an app package is recorded as a
`hasna.release.v1` document in a local ledger, a typed `release.published` event is emitted through
the `@hasna/events` envelope, and the four standard downstream follow-ups (changelog publish, fleet
update, announcement, docs refresh) are fanned out as todos tasks — or to a durable local outbox
when the `todos` CLI is not available.

## Install

```bash
bun install -g @hasna/releases
```

## Usage

```bash
# Record a publish receipt (the publish path is how the publish happened: skill | ci)
releases record @hasna/todos@1.4.2 --sha 0f4c2d1 --path skill

# Show the ledger status for a package
releases status @hasna/todos

# List recent release records
releases list --limit 20

# Reconcile the ledger against the npm registry.
# Versions that exist on npm but not in the ledger are backfilled as publishPath=backfilled
# and flagged as ledger-bypassing publishes.
releases reconcile
releases reconcile @hasna/todos @hasna/events
```

All commands print JSON. Data lives in `~/.hasna/releases` (override with `RELEASES_DATA_DIR`).

### Record options

| Flag | Meaning |
| --- | --- |
| `--sha <gitSha>` | Git SHA the publish was cut from (7-40 hex chars, required) |
| `--path <skill\|ci>` | Publish path (required; `backfilled` is reserved for `releases reconcile`) |
| `--app <appId>` | App id slug; defaults to `open-<name>` derived from the npm package name |
| `--published-at <iso>` | Publish timestamp; defaults to now |
| `--evidence <uri>` | Evidence URI (repeatable); a CLI-record evidence pointer is synthesized when omitted |
| `--changelog-ref <uri>` | Changelog resource pointer URI (deferred refs are legal; omit until it exists) |
| `--no-fanout` | Skip creating the downstream fan-out tasks |

## Downstream fan-out

Recording a release creates four follow-up tasks via the `todos` CLI:

1. Publish the changelog for the release
2. Roll out the update across the fleet
3. Announce the release
4. Refresh docs / regenerate the landing page

If the `todos` CLI is unavailable (or a create fails), the tasks are appended to
`~/.hasna/releases/outbox.jsonl` so nothing is lost; drain the outbox later with any todos-capable
agent.

## Events

`releases record` emits a `release.published` event (typed distribution event catalog, payload
mirrors `hasna.release.v1`) through the `@hasna/events` envelope into the local events store at
`~/.hasna/releases/events`.

## MCP server

```bash
releases-mcp
```

Tools: `releases_record`, `releases_status`, `releases_list`, `releases_reconcile`.

## Contracts

Ledger records validate against a vendored structural mirror of the `hasna.release.v1` schema from
`@hasna/contracts` (branch `feat/distribution-schemas`, not yet published). Evidence refs are
required unless `publishPath === "backfilled"`.

## Development

```bash
bun install
bun test
bun run build
```

## License

Apache-2.0
