import type { SqlStep } from "../executor";
import type { WasmEngine } from "./engine";

// Vendored by scripts/copy-wasm.ts; loaded at runtime, never bundled.
const WA_SQLITE_FACTORY = "/wa-sqlite/wa-sqlite-async.mjs";
const WA_SQLITE_API = "/wa-sqlite/src/sqlite-api.js";
const WA_SQLITE_IDB_VFS = "/wa-sqlite/src/examples/IDBBatchAtomicVFS.js";

type WaSqliteStatement = unknown;

interface WaSqlite3 {
  open_v2(name: string, flags: number, vfs?: string): Promise<number>;
  vfs_register(vfs: unknown, makeDefault: boolean): void;
  statements(db: number, sql: string): AsyncGenerator<WaSqliteStatement>;
  bind_collection(stmt: WaSqliteStatement, params: unknown[]): number;
  step(stmt: WaSqliteStatement): Promise<number>;
  column_names(stmt: WaSqliteStatement): string[];
  column(stmt: WaSqliteStatement, index: number): unknown;
  changes(db: number): number;
  close(db: number): Promise<void>;
}

interface WaSqliteApi {
  SQLITE_OPEN_READWRITE: number;
  SQLITE_OPEN_CREATE: number;
  SQLITE_ROW: number;
  Factory(module: unknown): WaSqlite3;
}

interface IdbVfsModule {
  IDBBatchAtomicVFS: new (databaseName: string) => { name: string };
}

export async function openWaSqliteEngine(
  databaseName: string
): Promise<WasmEngine> {
  const [factoryModule, apiModule, vfsModule] = await Promise.all([
    import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ WA_SQLITE_FACTORY
    ),
    import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ WA_SQLITE_API
    ),
    import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ WA_SQLITE_IDB_VFS
    ),
  ]);

  const module = await (
    factoryModule as { default: () => Promise<unknown> }
  ).default();

  const api = apiModule as unknown as WaSqliteApi;
  const sqlite3 = api.Factory(module);

  const vfs = new (
    vfsModule as unknown as IdbVfsModule
  ).IDBBatchAtomicVFS(databaseName);
  sqlite3.vfs_register(vfs, true);

  const db = await sqlite3.open_v2(
    databaseName,
    api.SQLITE_OPEN_READWRITE | api.SQLITE_OPEN_CREATE,
    vfs.name
  );

  async function all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const rows: Record<string, unknown>[] = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length > 0) sqlite3.bind_collection(stmt, params);
      while ((await sqlite3.step(stmt)) === api.SQLITE_ROW) {
        const names = sqlite3.column_names(stmt);
        const row: Record<string, unknown> = {};
        for (let i = 0; i < names.length; i += 1) {
          row[names[i]] = sqlite3.column(stmt, i);
        }
        rows.push(row);
      }
    }
    return rows as T[];
  }

  async function run(
    sql: string,
    params: unknown[] = []
  ): Promise<{ changes: number }> {
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length > 0) sqlite3.bind_collection(stmt, params);
      while ((await sqlite3.step(stmt)) === api.SQLITE_ROW) {
        // drain
      }
    }
    return { changes: sqlite3.changes(db) };
  }

  await run("PRAGMA busy_timeout = 5000");

  return {
    mode: "idb",
    name: "wa-sqlite/indexeddb",
    all,
    run,
    async exec(sql) {
      await run(sql);
    },
    async batch(statements: SqlStep[]) {
      await run("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) {
          await run(statement.sql, statement.params ?? []);
        }
        await run("COMMIT");
      } catch (error) {
        try {
          await run("ROLLBACK");
        } catch {
          // the original error is more useful
        }
        throw error;
      }
    },
    async close() {
      await sqlite3.close(db);
    },
  };
}
