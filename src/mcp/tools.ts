import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ledgerDbPath } from "../lib/config.js";
import { DuplicateReleaseError, ReleaseLedger } from "../lib/ledger.js";
import { recordRelease } from "../lib/record.js";
import { reconcileReleases } from "../lib/reconcile.js";

function jsonText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export interface ReleasesMcpToolOptions {
  dataDir?: string;
}

export function registerReleasesMcpTools(server: McpServer, options: ReleasesMcpToolOptions = {}): void {
  server.tool(
    "releases_record",
    "Record a publish receipt (hasna.release.v1) in the release ledger, emit release.published, and fan out downstream tasks",
    {
      package: z.string().describe("npm package name, e.g. @hasna/todos"),
      version: z.string().describe("Published semver version"),
      git_sha: z.string().describe("Git SHA the publish was cut from (7-40 hex chars)"),
      publish_path: z.enum(["skill", "ci"]).describe("How the publish happened"),
      app_id: z.string().optional().describe("App id slug; default derived open-<name>"),
      published_at: z.string().optional().describe("ISO publish timestamp; default now"),
      evidence_uris: z.array(z.string()).optional().describe("Evidence URIs"),
      changelog_ref_uri: z.string().optional().describe("Changelog resource pointer URI"),
      fanout: z.boolean().optional().describe("Create downstream fan-out tasks; default true"),
      project: z.string().optional().describe("Todos project for fan-out tasks"),
    },
    async (args) => {
      try {
        const result = await recordRelease(
          {
            package: args.package,
            version: args.version,
            gitSha: args.git_sha,
            publishPath: args.publish_path,
            appId: args.app_id,
            publishedAt: args.published_at,
            evidenceUris: args.evidence_uris,
            changelogRefUri: args.changelog_ref_uri,
          },
          { dataDir: options.dataDir, fanout: args.fanout !== false, fanoutProject: args.project },
        );
        return jsonText({
          recorded: true,
          release: result.release,
          event: { id: result.event.id, type: result.event.type, subject: result.event.subject },
          fanout: result.fanout,
        });
      } catch (error) {
        if (error instanceof DuplicateReleaseError) return jsonText({ recorded: false, error: error.message });
        return jsonText({ recorded: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  server.tool(
    "releases_status",
    "Show the release ledger status for a package",
    {
      package: z.string().describe("npm package name"),
      limit: z.number().optional().describe("Max records; default 20"),
    },
    async (args) => {
      const ledger = new ReleaseLedger(ledgerDbPath(options.dataDir));
      try {
        const records = ledger.listByPackage(args.package, args.limit ?? 20);
        return jsonText({
          package: args.package,
          recorded_releases: ledger.count(args.package),
          latest: records[0] ?? null,
          records,
        });
      } finally {
        ledger.close();
      }
    },
  );

  server.tool(
    "releases_list",
    "List recent release records across all packages",
    {
      limit: z.number().optional().describe("Max records; default 50"),
    },
    async (args) => {
      const ledger = new ReleaseLedger(ledgerDbPath(options.dataDir));
      try {
        return jsonText({ total: ledger.count(), records: ledger.list(args.limit ?? 50) });
      } finally {
        ledger.close();
      }
    },
  );

  server.tool(
    "releases_reconcile",
    "Diff npm registry latest versions against the ledger; backfill and flag ledger-bypassing publishes",
    {
      packages: z.array(z.string()).optional().describe("Packages to reconcile; default: every package in the ledger"),
      timeout_ms: z.number().optional().describe("npm view timeout per package; default 20000"),
    },
    async (args) =>
      jsonText(
        reconcileReleases({
          packages: args.packages,
          dataDir: options.dataDir,
          timeoutMs: args.timeout_ms,
        }),
      ),
  );
}
