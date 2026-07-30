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

## Ship-gap detection — `releases shipgap`

`reconcile` answers "does the ledger agree with npm?". It cannot see the two gaps
that actually reach users:

```
merged  !=  published  !=  installed  !=  running
```

Each link needs its own artefact and none may be inferred from the previous one.
`shipgap` measures all three states at once — the version in `package.json` on
the default branch, the version the npm registry serves, and the version
installed on every machine in the fleet manifest — and reports where they
disagree.

```bash
# Everything: both orgs, every repo, every machine in the manifest.
releases shipgap

# Just the numbers, for a dashboard or an alert.
releases shipgap --json

# Metadata only — no ssh, no SSM, no machines touched.
releases shipgap --skip-fleet

# Replay against history: what did this look like on the 29th?
releases shipgap --only hasna/projects --as-of 2026-07-29T00:00:00Z --skip-fleet

# Gate a pipeline. Exits 2 on a real gap, AND on a sweep that could not measure —
# a clean result that is clean because nothing could be read is not good news.
releases shipgap --skip-fleet --fail-on-gap
```

### What it distinguishes, and why each needs a different response

| Ship status | Meaning | Response |
| --- | --- | --- |
| `unshipped_changes` | Branch and registry agree on the version, but commits landed after that version was published. **The published dist does not contain the merged fix.** | Bump and publish |
| `behind_publish` | The branch carries a higher version than the registry. The bump merged; nobody published. | Publish |
| `never_published` | Declared publishable, never appeared on the registry. | Publish, or mark private |
| `registry_ahead` | The registry is ahead of the branch — published from somewhere other than this branch, or the branch was reverted. | Investigate |
| `registry_unknown` | The registry could not be queried. **Unmeasured, not clean.** | Fix credentials and re-run |
| `shipped` | Branch and registry agree with no shipping-relevant commits since. | — |

| Fleet status | Meaning |
| --- | --- |
| `absent_everywhere` | Published, installed on no measured machine |
| `partial_rollout` | Installed on some machines, absent on others |
| `version_skew` | Installed everywhere, at differing versions |
| `uniformly_stale` | Every machine agrees — and every machine is behind the registry |
| `current` | Every measured machine is on the registry latest |

`unshipped_changes` is the dangerous one because nothing about it looks wrong:
the PR is merged, the tests are green, the task is closed, and the version
numbers match. Only the commit evidence distinguishes it from a healthy package.

### Design notes, each of them load-bearing

- **The npm registry API is authoritative for "is it published", not `npm view`.**
  `npm view` was measured returning a stale version for minutes after a
  successful publish while `registry.npmjs.org` already served the new one.
- **A failed registry lookup is not an absent package.** 404, 401 and 403 are
  indistinguishable on a restricted scope, so absence is only concluded when
  every available credential agrees. `$NPM_TOKEN` and `~/.npmrc` are not
  necessarily the same token, and preferring the wrong one makes a published
  package report as never published.
- **"Shipping-relevant" is a denylist of prose and CI paths, not an `src/`
  allowlist.** A security fix that stopped a package publishing publicly touched
  only `package.json`, `scripts/` and `tests/`; an `src/`-only rule reports that
  repo clean.
- **Repo enumeration is checked against the org's own repo counts** and reported
  as `COMPLETE` or `INCOMPLETE`. A list that looks authoritative and is not is
  the failure this tool exists to catch.
- **Fleet membership comes from the `machines` manifest**, and machines that
  could not be measured are named in the output with their reason. A sweep that
  reached 16 of 18 machines must never render as "the fleet is current".
- **ssh is not the only transport.** Machines whose manifest address is a
  VPC-internal name are unreachable over ssh and perfectly reachable over SSM; an
  ssh-only sweep reports them dead. SSM runs as root, so the payload re-enters as
  the owning user or it reads the wrong `$HOME` and returns the wrong versions.
- **A probe returning zero packages is rejected as unreliable**, not recorded as
  an empty machine. An exit code of 0 with no output is what a broken payload
  looks like.
- **All three axes disclose when they could not be read.** The registry axis has
  `registry_unknown`, the commit axis has `commits_unknown`, and the fleet axis
  reports `measured` separately from the manifest size. `--fail-on-gap` exits
  non-zero on an unmeasured sweep as well as on a real gap.
- **Positive evidence outranks partial blindness.** If part of a commit history
  is unreadable but a commit that *was* read is shipping-relevant, the gap is
  proven and reported as `unshipped_changes` with its counts marked as a lower
  bound — never downgraded to `commits_unknown`. Knowing of one real gap is
  strictly more information than knowing nothing.

### Read-only with respect to state — but it does execute subprocesses

`shipgap` and `gates` create, modify and delete nothing: no installs, no writes,
no publishes. They are not, however, free of subprocess execution. `shipgap`
runs a small shell payload locally via `bash -lc` and ships the same payload to
each machine over ssh or SSM. That payload only greps `"name"` and `"version"`
out of `package.json` files already on disk and prints them — it installs
nothing and triggers no lifecycle scripts — but in a tool about false
reassurance, "read-only" must not be allowed to blur into "executes nothing".

### What `--fail-on-gap` treats as failure

Deliberate, because the two halves are different claims:

| Condition | Gates? |
| --- | --- |
| A real gap (`unshipped_changes` / `behind_publish`) | yes |
| An axis that could not be read (`registry_unknown` / `commits_unknown`) | yes |
| A fleet sweep **attempted** that reached no machine | yes |
| `--skip-fleet` — the fleet was deliberately not asked | **no** |

Declining to ask is not the same as asking and learning nothing. Gating on
`--skip-fleet` would make the flag useless; not gating on a fleet sweep that
reached nothing would reintroduce exactly the blind spot this gate exists for.

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
