declare module "bun:sqlite" {
  export class Statement {
    run(
      ...params: unknown[]
    ): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class Database {
    constructor(path?: string, options?: { readonly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction<T>(fn: (...args: never[]) => T): () => T;
    close(): void;
  }
}
