import { Database } from "bun:sqlite";
import { ledgerDbPath } from "./config.js";
import { parseRelease, type Release } from "../vendor/contracts.js";

interface ReleaseRow {
  id: string;
  app_id: string;
  package: string;
  version: string;
  git_sha: string;
  published_at: string;
  publish_path: string;
  created_at: string;
  record_json: string;
}

export class DuplicateReleaseError extends Error {
  constructor(pkg: string, version: string) {
    super(`Release already recorded in ledger: ${pkg}@${version}`);
    this.name = "DuplicateReleaseError";
  }
}

/**
 * SQLite-backed ledger of `hasna.release.v1` documents.
 * Rows are indexed columns for querying; the full validated document is
 * stored as JSON alongside (sibling storage pattern).
 */
export class ReleaseLedger {
  private db: Database;

  constructor(pathOrDb?: string | Database) {
    this.db = pathOrDb instanceof Database ? pathOrDb : new Database(pathOrDb ?? ledgerDbPath());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        package TEXT NOT NULL,
        version TEXT NOT NULL,
        git_sha TEXT NOT NULL,
        published_at TEXT NOT NULL,
        publish_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(package, version)
      );
      CREATE INDEX IF NOT EXISTS idx_releases_package ON releases(package, published_at DESC);
    `);
  }

  insert(release: Release): Release {
    const validated = parseRelease(release);
    if (this.has(validated.package, validated.version)) {
      throw new DuplicateReleaseError(validated.package, validated.version);
    }
    this.db
      .query(
        `INSERT INTO releases (id, app_id, package, version, git_sha, published_at, publish_path, created_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.appId,
        validated.package,
        validated.version,
        validated.gitSha,
        validated.publishedAt,
        validated.publishPath,
        validated.createdAt,
        JSON.stringify(validated),
      );
    return validated;
  }

  has(pkg: string, version: string): boolean {
    return Boolean(
      this.db.query("SELECT 1 FROM releases WHERE package = ? AND version = ?").get(pkg, version),
    );
  }

  listByPackage(pkg: string, limit = 50): Release[] {
    const rows = this.db
      .query<ReleaseRow, [string, number]>(
        "SELECT * FROM releases WHERE package = ? ORDER BY published_at DESC, created_at DESC LIMIT ?",
      )
      .all(pkg, Math.max(1, Math.min(limit, 500)));
    return rows.map((row) => JSON.parse(row.record_json) as Release);
  }

  latestFor(pkg: string): Release | null {
    return this.listByPackage(pkg, 1)[0] ?? null;
  }

  list(limit = 50): Release[] {
    const rows = this.db
      .query<ReleaseRow, [number]>(
        "SELECT * FROM releases ORDER BY published_at DESC, created_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(limit, 500)));
    return rows.map((row) => JSON.parse(row.record_json) as Release);
  }

  listPackages(): string[] {
    const rows = this.db
      .query<{ package: string }, []>("SELECT DISTINCT package FROM releases ORDER BY package")
      .all();
    return rows.map((row) => row.package);
  }

  count(pkg?: string): number {
    const row = pkg
      ? this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM releases WHERE package = ?").get(pkg)
      : this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM releases").get();
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
