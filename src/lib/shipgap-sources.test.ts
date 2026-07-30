import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enumerateOrgRepos,
  fetchBranchManifest,
  fetchCommitsSince,
  fetchRegistryFacts,
  installedPackagesScript,
  loadManifestMachines,
  probeMachine,
  type RunResult,
  type Runner,
} from "./shipgap-sources.js";
import { readNpmrcToken } from "./npmrc.js";

function ok(stdout: string): RunResult {
  return { status: 0, stdout, stderr: "" };
}
function err(stderr: string, status = 1): RunResult {
  return { status, stdout: "", stderr };
}

/** Records every invocation so tests can assert on transport order. */
function scriptedRunner(handler: (command: string, args: string[]) => RunResult): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    return handler(command, args);
  }) as Runner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

describe("org enumeration proves completeness rather than asserting it", () => {
  const listing = [
    JSON.stringify({ name: "projects", defaultBranch: "main", archived: false }),
    JSON.stringify({ name: "identities", defaultBranch: "main", archived: false }),
  ].join("\n");

  test("reports complete when the count matches the org's own numbers", () => {
    const runner = scriptedRunner((_command, args) =>
      args.includes("orgs/hasna") ? ok(JSON.stringify({ public: 1, private: 1 })) : ok(listing),
    );
    const result = enumerateOrgRepos("hasna", runner);
    expect(result.repos).toHaveLength(2);
    expect(result.completeness).toEqual({ org: "hasna", enumerated: 2, org_reports: 2, complete: true });
  });

  test("reports INCOMPLETE when pagination silently dropped repos", () => {
    const runner = scriptedRunner((_command, args) =>
      args.includes("orgs/hasna") ? ok(JSON.stringify({ public: 90, private: 12 })) : ok(listing),
    );
    const result = enumerateOrgRepos("hasna", runner);
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.org_reports).toBe(102);
  });
});

describe("branch manifest", () => {
  test("decodes base64 contents", () => {
    const payload = Buffer.from(JSON.stringify({ name: "@hasna/x", version: "1.2.3", private: true })).toString("base64");
    const runner = scriptedRunner(() => ok(payload));
    expect(fetchBranchManifest({ org: "hasna", repo: "x", defaultBranch: "main", archived: false }, runner)).toEqual({
      name: "@hasna/x",
      version: "1.2.3",
      private: true,
    });
  });

  test("a repo with no package.json yields nulls rather than throwing", () => {
    const runner = scriptedRunner(() => err("gh: Not Found (HTTP 404)"));
    expect(fetchBranchManifest({ org: "hasna", repo: "x", defaultBranch: "main", archived: false }, runner)).toEqual({
      name: null,
      version: null,
      private: false,
    });
  });
});

describe("registry facts come from the registry API, not npm view", () => {
  const doc = {
    "dist-tags": { latest: "0.1.96" },
    versions: { "0.1.89": {}, "0.1.95": {}, "0.1.96": {} },
    time: {
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-07-30T12:28:53.815Z",
      "0.1.89": "2026-07-08T23:19:36.882Z",
      "0.1.95": "2026-07-24T20:54:34.923Z",
      "0.1.96": "2026-07-30T12:28:53.815Z",
    },
  };
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => doc })) as unknown as typeof fetch;

  test("reads dist-tags for a live run", async () => {
    const facts = await fetchRegistryFacts("@hasna/projects", { fetchImpl });
    expect(facts.latest).toBe("0.1.96");
    expect(facts.latestPublishedAt).toBe("2026-07-30T12:28:53.815Z");
    expect(facts.found).toBe(true);
  });

  test("reconstructs what latest WAS at a historical instant", async () => {
    // Mid-incident: after 0.1.95 shipped, before 0.1.96 existed.
    const facts = await fetchRegistryFacts("@hasna/projects", { fetchImpl, asOf: "2026-07-29T00:00:00.000Z" });
    expect(facts.latest).toBe("0.1.95");
    expect(facts.latestPublishedAt).toBe("2026-07-24T20:54:34.923Z");
  });

  test("as-of before the first publish reports nothing published yet", async () => {
    const facts = await fetchRegistryFacts("@hasna/projects", { fetchImpl, asOf: "2026-07-01T00:00:00.000Z" });
    expect(facts.latest).toBeNull();
  });

  test("does not treat created/modified as versions", async () => {
    const facts = await fetchRegistryFacts("@hasna/projects", { fetchImpl });
    expect(Object.keys(facts.times).sort()).toEqual(["0.1.89", "0.1.95", "0.1.96"]);
  });

  test("404 means absent from the registry, not an error", async () => {
    const missing = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const facts = await fetchRegistryFacts("@hasna/nope", { fetchImpl: missing });
    expect(facts.found).toBe(false);
    expect(facts.latest).toBeNull();
  });

  test("a credential that cannot see a restricted scope does not make it look unpublished", async () => {
    // Measured 2026-07-30: $NPM_TOKEN on the fleet is a different token from the
    // one in ~/.npmrc and cannot read @hasnaxyz. Preferring it reported the
    // published @hasnaxyz/factory as "never published" — a false clean.
    const calls: Array<string | undefined> = [];
    const restricted = (async (_url: string, init: { headers: Record<string, string> }) => {
      const auth = init.headers.Authorization;
      calls.push(auth);
      if (auth !== "Bearer good-token") return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => doc };
    }) as unknown as typeof fetch;

    const facts = await fetchRegistryFacts("@hasnaxyz/factory", {
      fetchImpl: restricted,
      token: "blind-token",
      fallbackTokens: ["good-token"],
    });
    expect(facts.found).toBe(true);
    expect(facts.latest).toBe("0.1.96");
    expect(calls).toEqual(["Bearer blind-token", "Bearer good-token"]);
  });

  test("absence is only concluded when every credential agrees on 404", async () => {
    const calls: string[] = [];
    const allMissing = (async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers.Authorization ?? "none");
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const facts = await fetchRegistryFacts("@hasna/never-existed", {
      fetchImpl: allMissing,
      token: "a",
      fallbackTokens: ["b"],
    });
    expect(facts.found).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("a real registry error is raised, never silently reported as unpublished", async () => {
    const broken = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchRegistryFacts("@hasna/x", { fetchImpl: broken })).rejects.toThrow("registry 500");
  });
});

describe("commits since publish", () => {
  const ref = { org: "hasna", repo: "projects", defaultBranch: "main", archived: false };

  test("collects file paths per commit", () => {
    const runner = scriptedRunner((_command, args) => {
      const target = args[1] ?? "";
      if (target.includes("/commits?")) return ok("sha1\nsha2");
      if (target.endsWith("/commits/sha1")) {
        return ok(JSON.stringify({ sha: "sha1", committedAt: "2026-07-26T16:12:35Z", paths: ["src/a.ts"] }));
      }
      return ok(JSON.stringify({ sha: "sha2", committedAt: "2026-07-27T10:00:00Z", paths: ["README.md"] }));
    });
    const result = fetchCommitsSince(ref, "2026-07-24T20:54:34.923Z", runner);
    expect(result.commits.map((commit) => commit.sha)).toEqual(["sha1", "sha2"]);
    expect(result.commits[0]?.paths).toEqual(["src/a.ts"]);
  });

  test("drops a commit stamped exactly at the publish instant", () => {
    // The version-bump commit and the publish share a timestamp; counting it
    // would report every freshly published package as unshipped.
    const runner = scriptedRunner((_command, args) => {
      const target = args[1] ?? "";
      if (target.includes("/commits?")) return ok("bump");
      return ok(JSON.stringify({ sha: "bump", committedAt: "2026-07-24T20:54:34.923Z", paths: ["package.json"] }));
    });
    expect(fetchCommitsSince(ref, "2026-07-24T20:54:34.923Z", runner).commits).toHaveLength(0);
  });

  test("a failed commit list reports ok:false, never an empty history", () => {
    // An unreadable history returned as `[]` makes the classifier answer
    // "shipped" for a package it could not inspect.
    const runner = scriptedRunner(() => err("gh: API rate limit exceeded"));
    const result = fetchCommitsSince(ref, "2026-07-24T20:54:34.923Z", runner);
    expect(result.ok).toBe(false);
    expect(result.commits).toHaveLength(0);
    expect(result.error).toContain("rate limit");
  });

  test("a partially readable history is also ok:false — the unread commit may be the one that matters", () => {
    const runner = scriptedRunner((_command, args) => {
      const target = args[1] ?? "";
      if (target.includes("/commits?")) return ok("sha1\nsha2");
      if (target.endsWith("/commits/sha1")) {
        return ok(JSON.stringify({ sha: "sha1", committedAt: "2026-07-26T00:00:00Z", paths: ["README.md"] }));
      }
      return err("gh: Not Found");
    });
    const result = fetchCommitsSince(ref, "2026-07-24T20:54:34.923Z", runner);
    expect(result.ok).toBe(false);
    expect(result.commits).toHaveLength(1);
    expect(result.error).toContain("sha2");
  });

  test("a fully readable history reports ok:true", () => {
    const runner = scriptedRunner((_command, args) => {
      const target = args[1] ?? "";
      if (target.includes("/commits?")) return ok("sha1");
      return ok(JSON.stringify({ sha: "sha1", committedAt: "2026-07-26T00:00:00Z", paths: ["src/a.ts"] }));
    });
    expect(fetchCommitsSince(ref, "2026-07-24T20:54:34.923Z", runner).ok).toBe(true);
  });

  test("flags truncation instead of silently capping", () => {
    const runner = scriptedRunner((_command, args) => {
      const target = args[1] ?? "";
      if (target.includes("/commits?")) return ok(Array.from({ length: 5 }, (_, i) => `s${i}`).join("\n"));
      return ok(JSON.stringify({ sha: "s", committedAt: "2026-07-30T00:00:00Z", paths: ["src/a.ts"] }));
    });
    const result = fetchCommitsSince(ref, "2026-07-24T00:00:00Z", runner, { limit: 3 });
    expect(result.truncated).toBe(true);
    expect(result.commits).toHaveLength(3);
  });
});

describe("fleet probing", () => {
  const machine = { id: "spark02", friendlyName: "station02", hostname: "station02", sshAddress: "hasna@station02" };

  test("the install script reads the invoking user's bun global root", () => {
    const script = installedPackagesScript(["@hasna"]);
    expect(script).toContain("$HOME/.bun/install/global/node_modules/$__s/*/package.json");
  });

  test("ssh success is used directly", () => {
    const runner = scriptedRunner((command) =>
      command === "ssh" ? ok("@hasna/projects\t0.1.89\n@hasna/todos\t1.0.0\n") : err("unexpected"),
    );
    const probe = probeMachine(machine, { runner });
    expect(probe.ok).toBe(true);
    expect(probe.transport).toBe("ssh");
    expect(probe.packages["@hasna/projects"]).toBe("0.1.89");
  });

  test("an ssh failure falls through to SSM rather than declaring the machine dead", () => {
    // station17/18 look dead over ssh because their manifest address is a
    // VPC-internal name; they are Online via SSM. An ssh-only sweep undercounts.
    const runner = scriptedRunner((command, args) => {
      if (command === "ssh") return err("Could not resolve hostname ip-172-31-15-132.ec2.internal");
      if (command === "aws" && args.includes("describe-instance-information")) return ok("i-0abc\n");
      if (command === "aws" && args.includes("send-command")) return ok("cmd-1\n");
      if (command === "aws" && args.includes("get-command-invocation")) {
        return ok(JSON.stringify(["Success", "@hasna/projects\t0.1.96\n"]));
      }
      return err("unexpected");
    });
    const probe = probeMachine({ ...machine, id: "station17", sshAddress: "hasna@ip-172-31-15-132.ec2.internal" }, { runner });
    expect(probe.ok).toBe(true);
    expect(probe.transport).toBe("ssm");
    expect(probe.packages["@hasna/projects"]).toBe("0.1.96");
  });

  test("the SSM payload re-enters as the owning user, because SSM runs as root", () => {
    const runner = scriptedRunner((command, args) => {
      if (command === "ssh") return err("timeout");
      if (command === "aws" && args.includes("describe-instance-information")) return ok("i-0abc\n");
      if (command === "aws" && args.includes("send-command")) return ok("cmd-1\n");
      return ok(JSON.stringify(["Success", "@hasna/x\t1.0.0\n"]));
    });
    probeMachine({ ...machine, id: "station17", sshAddress: "hasna@ip-172-31-15-132.ec2.internal" }, { runner });
    const send = runner.calls.find((call) => call.includes("send-command"));
    expect(send).toBeDefined();
    const params = (send ?? []).join(" ");
    expect(params).toContain("sudo -u hasna -H bash -lc");
    // $HOME must have been resolved away; root's home would give wrong versions.
    expect(params).toContain("/home/hasna/.bun/install/global");
  });

  test("the SSM payload is SINGLE-quoted so the root shell cannot expand it away", () => {
    // Measured on station17: a double-quoted payload had `$__d` expanded by the
    // root shell before sudo ran. The inner loop then listed nothing, exited 0,
    // and the machine reported 0 packages while actually holding 42.
    const runner = scriptedRunner((command, args) => {
      if (command === "ssh") return err("timeout");
      if (command === "aws" && args.includes("describe-instance-information")) return ok("i-0abc\n");
      if (command === "aws" && args.includes("send-command")) return ok("cmd-1\n");
      return ok(JSON.stringify(["Success", "@hasna/x\t1.0.0\n"]));
    });
    probeMachine({ ...machine, id: "station17", sshAddress: "hasna@ip-172-31-15-132.ec2.internal" }, { runner });
    const params = (runner.calls.find((call) => call.includes("send-command")) ?? []).join(" ");
    expect(params).toContain("bash -lc '");
    // The loop variables must survive verbatim into the payload.
    expect(params).toContain("$__d");
    expect(params).toContain("$__s");
  });

  test("a probe that returns zero packages is unreliable, not an empty machine", () => {
    const runner = scriptedRunner((command) => (command === "ssh" ? ok("") : err("no")));
    const probe = probeMachine(machine, { runner });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("0 packages");
  });

  test("a genuinely bare machine can still be measured when minPackages is 0", () => {
    const runner = scriptedRunner((command) => (command === "ssh" ? ok("") : err("no")));
    const probe = probeMachine(machine, { runner, minPackages: 0 });
    expect(probe.ok).toBe(true);
    expect(probe.packages).toEqual({});
  });

  test("a machine reachable by neither transport is reported unreachable with a reason", () => {
    const runner = scriptedRunner((command, args) => {
      if (command === "ssh") return err("ssh: connect to host station04 port 22: Connection timed out");
      if (command === "aws" && args.includes("describe-instance-information")) return ok("None\n");
      return err("no");
    });
    const probe = probeMachine({ ...machine, id: "apple01" }, { runner });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("Connection timed out");
  });

  test("manifest machines come from the machines CLI, not a hardcoded list", () => {
    const runner = scriptedRunner(() =>
      ok(JSON.stringify({ machines: [{ id: "spark01" }, { id: "spark02" }, { id: "station17" }] })),
    );
    expect(loadManifestMachines(runner).map((entry) => entry.id)).toEqual(["spark01", "spark02", "station17"]);
  });
});

describe("registry token handling", () => {
  test("reads a token from .npmrc without it appearing anywhere else", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipgap-npmrc-"));
    const file = join(dir, ".npmrc");
    // Deliberately NOT shaped like a real npm token: the staged-diff secrets
    // scan must stay signal, and a fixture that trips it trains people to ignore it.
    writeFileSync(file, "//registry.npmjs.org/:_authToken=fixture-value-not-a-credential\nregistry=https://x\n");
    expect(readNpmrcToken(file)).toBe("fixture-value-not-a-credential");
  });

  test("expands ${VAR} indirection rather than returning the literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipgap-npmrc-"));
    const file = join(dir, ".npmrc");
    writeFileSync(file, "//registry.npmjs.org/:_authToken=${SHIPGAP_TEST_TOKEN}\n");
    process.env.SHIPGAP_TEST_TOKEN = "resolved-value";
    expect(readNpmrcToken(file)).toBe("resolved-value");
    delete process.env.SHIPGAP_TEST_TOKEN;
  });

  test("a missing .npmrc yields undefined, not a crash", () => {
    expect(readNpmrcToken(join(tmpdir(), "definitely-absent-npmrc"))).toBeUndefined();
  });
});
