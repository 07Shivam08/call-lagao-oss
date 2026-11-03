import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { REPO_ROOT } from "./env.js";

export type Row = Record<string, any>;

export interface Db {
  kind: "pglite" | "postgres";
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` in a transaction; the callback gets a Db bound to the same connection. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = resolve(REPO_ROOT, "packages/db/migrations");

function pgliteDb(client: PGlite, inTx = false): Db {
  return {
    kind: "pglite",
    async query(sql, params = []) {
      const r = await client.query(sql, params as any[]);
      return r.rows as any[];
    },
    async tx(fn) {
      if (inTx) return fn(this);
      return client.transaction(async (t) => fn(pgliteDb(t as unknown as PGlite, true)));
    },
    close: () => client.close(),
  };
}

function postgresDb(pool: pg.Pool): Db {
  const wrap = (c: pg.PoolClient): Db => ({
    kind: "postgres",
    query: async (sql, params = []) => (await c.query(sql, params as any[])).rows,
    tx: (fn) => fn(wrap(c)),
    close: async () => undefined,
  });
  return {
    kind: "postgres",
    query: async (sql, params = []) => (await pool.query(sql, params as any[])).rows,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const out = await fn(wrap(c));
        await c.query("commit");
        return out;
      } catch (e) {
        await c.query("rollback");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

/** `databaseUrl` empty → embedded PGlite at `dataDir` (or in-memory when dataDir is "memory"). */
export async function openDb(databaseUrl: string, dataDir: string): Promise<Db> {
  let db: Db;
  if (databaseUrl) {
    db = postgresDb(new pg.Pool({ connectionString: databaseUrl, max: 10 }));
  } else if (dataDir === "memory") {
    db = pgliteDb(new PGlite());
  } else {
    mkdirSync(dataDir, { recursive: true });
    db = pgliteDb(new PGlite(dataDir));
  }
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ name: string }>(`select name from schema_migrations`)).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    await db.tx(async (t) => {
      // PGlite's query() runs one statement; exec-style multi-statement support differs per driver.
      for (const stmt of splitSql(sql)) await t.query(stmt);
      await t.query(`insert into schema_migrations (name) values ($1)`, [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** Split on semicolons at end of line, ignoring `--` comments. Good enough for our hand-written migrations. */
function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
