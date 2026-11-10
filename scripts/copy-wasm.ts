import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname } from "path";

/**
 * Copies the SQLite WASM engines into public/ so the browser can load them
 * from stable URLs (bundlers cannot statically resolve the worker-side
 * dynamic import). Runs before `dev` and `build`.
 */
const COPIES = [
  {
    from: "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs",
    to: "public/sqlite-wasm/sqlite3.mjs",
  },
  {
    from: "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
    to: "public/sqlite-wasm/sqlite3.wasm",
  },
  {
    from: "node_modules/wa-sqlite/dist/wa-sqlite-async.wasm",
    to: "public/wa-sqlite/wa-sqlite-async.wasm",
  },
];

let missing = false;

for (const { from, to } of COPIES) {
  if (!existsSync(from)) {
    console.error(`Missing ${from}`);
    try {
      console.error("  available:", readdirSync(dirname(from)).join(", "));
    } catch {
      // Directory itself is missing — the message above is enough.
    }
    missing = true;
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}

if (missing) {
  console.error("Run `bun install` first.");
  process.exit(1);
}
