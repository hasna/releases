import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { outboxPath } from "./config.js";
import type { Release } from "../vendor/contracts.js";

export interface FanoutTask {
  fingerprint: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  tags: string[];
}

export type FanoutMode = "todos" | "outbox";

export interface FanoutDispatch {
  task: FanoutTask;
  via: FanoutMode;
  ok: boolean;
  error?: string;
}

export interface FanoutResult {
  mode: FanoutMode;
  outbox_path?: string;
  dispatched: FanoutDispatch[];
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { timeoutMs: number },
) => { status: number | null; stdout: string; stderr: string; error?: { code?: string; message: string } };

function spawnCommand(command: string, args: string[], opts: { timeoutMs: number }): ReturnType<CommandRunner> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } } : {}),
  };
}

/** The four standard downstream follow-ups for a recorded release. */
export function buildFanoutTasks(release: Release): FanoutTask[] {
  const spec = `${release.package}@${release.version}`;
  const context = [
    `Release: ${spec}`,
    `App: ${release.appId}`,
    `Git SHA: ${release.gitSha}`,
    `Published at: ${release.publishedAt} (path: ${release.publishPath})`,
    `Ledger record: ${release.id}`,
  ].join("\n");
  const base = { priority: "high" as const, tags: ["auto:route", "area:distribution", `app:${release.appId}`] };
  return [
    {
      ...base,
      fingerprint: `release-fanout:changelog:${spec}`,
      title: `Publish changelog for ${spec}`,
      description: `${context}\n\nCollect the changes shipped in this version and publish the changelog entry (open-changelog), then attach the changelogRef to the release record.`,
      tags: [...base.tags, "release-fanout:changelog"],
    },
    {
      ...base,
      fingerprint: `release-fanout:fleet-update:${spec}`,
      title: `Roll out ${spec} across the fleet`,
      description: `${context}\n\nUpdate every machine that runs ${release.package} to ${release.version}, verify CLI/MCP health, and record hasna.rollout_record.v1 receipts per machine.`,
      tags: [...base.tags, "release-fanout:fleet-update"],
    },
    {
      ...base,
      fingerprint: `release-fanout:announce:${spec}`,
      title: `Announce release ${spec}`,
      description: `${context}\n\nSend the release announcement through the configured channels and record the hasna.announcement.v1 receipt.`,
      priority: "medium",
      tags: [...base.tags, "release-fanout:announce"],
    },
    {
      ...base,
      fingerprint: `release-fanout:docs-refresh:${spec}`,
      title: `Refresh docs and regenerate landing page for ${release.package}`,
      description: `${context}\n\nRefresh README/docs references to the new version and regenerate the app landing page.`,
      priority: "medium",
      tags: [...base.tags, "release-fanout:docs-refresh"],
    },
  ];
}

function appendToOutbox(tasks: FanoutTask[], path: string, reason: string): FanoutDispatch[] {
  mkdirSync(dirname(path), { recursive: true });
  const now = new Date().toISOString();
  const lines = tasks
    .map((task) => JSON.stringify({ schema: "open-releases.fanout-task.v1", queuedAt: now, reason, task }))
    .join("\n");
  appendFileSync(path, `${lines}\n`, "utf8");
  return tasks.map((task) => ({ task, via: "outbox" as const, ok: true }));
}

export interface DispatchFanoutOptions {
  dataDir?: string;
  runner?: CommandRunner;
  timeoutMs?: number;
  project?: string;
}

/**
 * Create the fan-out tasks via the `todos` CLI when it is available; degrade
 * gracefully to a durable local outbox file (`outbox.jsonl`) when it is not.
 */
export function dispatchFanoutTasks(tasks: FanoutTask[], options: DispatchFanoutOptions = {}): FanoutResult {
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const outbox = outboxPath(options.dataDir);

  const probe = runner("todos", ["--version"], { timeoutMs: 5_000 });
  if (probe.error?.code === "ENOENT" || probe.status !== 0) {
    return {
      mode: "outbox",
      outbox_path: outbox,
      dispatched: appendToOutbox(tasks, outbox, probe.error?.code === "ENOENT" ? "todos CLI not found" : "todos CLI probe failed"),
    };
  }

  const dispatched: FanoutDispatch[] = [];
  const failed: FanoutTask[] = [];
  for (const task of tasks) {
    const args = [
      ...(options.project ? ["--project", options.project] : []),
      "add",
      task.title,
      "--description",
      task.description,
      "--priority",
      task.priority,
      "--tags",
      task.tags.join(","),
    ];
    const result = runner("todos", args, { timeoutMs });
    if (result.status === 0) {
      dispatched.push({ task, via: "todos", ok: true });
    } else {
      failed.push(task);
      dispatched.push({
        task,
        via: "todos",
        ok: false,
        error: (result.stderr || result.error?.message || `todos add exited ${result.status}`).slice(0, 500),
      });
    }
  }

  if (failed.length > 0) {
    dispatched.push(...appendToOutbox(failed, outbox, "todos add failed"));
    return { mode: failed.length === tasks.length ? "outbox" : "todos", outbox_path: outbox, dispatched };
  }
  return { mode: "todos", dispatched };
}
