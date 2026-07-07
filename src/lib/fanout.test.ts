import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFanoutTasks, dispatchFanoutTasks, type CommandRunner } from "./fanout.js";
import type { Release } from "../vendor/contracts.js";

const release: Release = {
  schema: "hasna.release.v1",
  id: "rel-fanout-1",
  createdAt: "2026-07-06T10:00:00.000Z",
  appId: "open-todos",
  package: "@hasna/todos",
  version: "1.4.2",
  gitSha: "0f4c2d1",
  publishedAt: "2026-07-06T10:00:00.000Z",
  publishPath: "skill",
  evidenceRefs: [{ id: "evd-1", uri: "https://example.com/log" }],
};

describe("buildFanoutTasks", () => {
  test("creates the four standard downstream tasks", () => {
    const tasks = buildFanoutTasks(release);
    expect(tasks).toHaveLength(4);
    expect(tasks.map((task) => task.fingerprint)).toEqual([
      "release-fanout:changelog:@hasna/todos@1.4.2",
      "release-fanout:fleet-update:@hasna/todos@1.4.2",
      "release-fanout:announce:@hasna/todos@1.4.2",
      "release-fanout:docs-refresh:@hasna/todos@1.4.2",
    ]);
    for (const task of tasks) {
      expect(task.description).toContain("@hasna/todos@1.4.2");
      expect(task.tags).toContain("app:open-todos");
    }
  });
});

describe("dispatchFanoutTasks", () => {
  test("dispatches via todos CLI when available", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "releases-fanout-"));
    const calls: string[][] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const result = dispatchFanoutTasks(buildFanoutTasks(release), { dataDir, runner });
    expect(result.mode).toBe("todos");
    expect(result.dispatched.every((entry) => entry.ok && entry.via === "todos")).toBe(true);
    // 1 probe + 4 adds
    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual(["todos", "--version"]);
    expect(calls[1]?.slice(0, 2)).toEqual(["todos", "add"]);
    expect(existsSync(join(dataDir, "outbox.jsonl"))).toBe(false);
  });

  test("degrades to the local outbox when the todos CLI is missing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "releases-fanout-"));
    const runner: CommandRunner = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "todos not found" },
    });
    const result = dispatchFanoutTasks(buildFanoutTasks(release), { dataDir, runner });
    expect(result.mode).toBe("outbox");
    expect(result.dispatched).toHaveLength(4);
    expect(result.dispatched.every((entry) => entry.ok && entry.via === "outbox")).toBe(true);

    const outbox = readFileSync(join(dataDir, "outbox.jsonl"), "utf8").trim().split("\n");
    expect(outbox).toHaveLength(4);
    const first = JSON.parse(outbox[0]!);
    expect(first.schema).toBe("open-releases.fanout-task.v1");
    expect(first.reason).toBe("todos CLI not found");
    expect(first.task.fingerprint).toBe("release-fanout:changelog:@hasna/todos@1.4.2");
  });

  test("falls back to the outbox for tasks whose todos add fails", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "releases-fanout-"));
    let adds = 0;
    const runner: CommandRunner = (_command, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0", stderr: "" };
      adds += 1;
      return adds === 2
        ? { status: 1, stdout: "", stderr: "boom" }
        : { status: 0, stdout: "ok", stderr: "" };
    };
    const result = dispatchFanoutTasks(buildFanoutTasks(release), { dataDir, runner });
    expect(result.mode).toBe("todos");
    const outboxed = result.dispatched.filter((entry) => entry.via === "outbox");
    expect(outboxed).toHaveLength(1);
    expect(readFileSync(join(dataDir, "outbox.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});
