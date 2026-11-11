import type { SqlStep } from "../executor";
import { DbBusyError, type WasmEngine } from "./engine";

// Vendored by scripts/copy-wasm.ts; loaded at runtime, never bundled.
const SQLITE_WASM_ENTRY = "/sqlite-wasm/sqlite3.mjs";

interface SqliteWasmDb {
  exec(options: {
    sql: string;
    bind?: unknown[];
    rowMode?: "object" | "array";
    returnValue?: "resultRows";
  }): unknown;
  changes(): number;
  transaction<T>(callback: (db: SqliteWasmDb) => T): T;
  close(): void;
}

interface OpfsPool {
  OpfsSAHPoolDb: new (file: string) => SqliteWasmDb;
}

interface SqliteWasmModule {
  installOpfsSAHPoolVfs?: (options: {
    name: string;
    directory: string;
    initialCapacity?: number;
  }) => Promise<OpfsPool>;
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /createSyncAccessHandle|NoModificationAllowedError|Access Handles cannot/i.test(
    message
  );
}

export async function openSqliteWasmEngine(fileName: string): Promise<WasmEngine> {
  const imported = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ SQLITE_WASM_ENTRY
  )) as { default: (options?: unknown) => Promise<SqliteWasmModule> };

  const sqlite3 = await imported.default({
    locateFile: (name: string) => `/sqlite-wasm/${name}`,
  });

  // Release builds strip `sqlite3.opfs`, so the installer is the supported
  // feature probe. It rejects by itself when the browser (or thread) lacks the
  // OPFS APIs, which lets the worker fall back to the IndexedDB engine.
  const installOpfs = sqlite3.installOpfsSAHPoolVfs;
  if (typeof installOpfs !== "function") {
    throw new Error("This sqlite3-wasm build has no OPFS support");
  }

  let pool: OpfsPool;
  try {
    pool = await installOpfs({
      name: "vocleap",
      directory: "/vocleap-pool",
      initialCapacity: 6,
    });
  } catch (error) {
    if (isBusy(error)) throw new DbBusyError();
    throw error;
  }

  let db: SqliteWasmDb;
  try {
    // Pool-relative path: the pool directory itself was chosen above.
    db = new pool.OpfsSAHPoolDb(`/${fileName}`);
  } catch (error) {
    if (isBusy(error)) throw new DbBusyError();
    throw error;
  }

  db.exec({ sql: "PRAGMA busy_timeout = 5000" });

  return {
    mode: "opfs",
    name: "sqlite-wasm/opfs-sahpool",
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const rows = db.exec({
        sql,
        bind: params,
        rowMode: "object",
        returnValue: "resultRows",
      });
      return (Array.isArray(rows) ? rows : []) as T[];
    },
    async run(sql, params = []) {
      db.exec({ sql, bind: params });
      return { changes: db.changes() };
    },
    async exec(sql) {
      db.exec({ sql });
    },
    async batch(statements: SqlStep[]) {
      db.transaction((tx) => {
        for (const statement of statements) {
          tx.exec({ sql: statement.sql, bind: statement.params ?? [] });
        }
      });
    },
    async close() {
      db.close();
    },
  };
}
