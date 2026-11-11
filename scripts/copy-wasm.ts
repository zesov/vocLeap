import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
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
  {
    // wa-sqlite-async.mjs is self-contained (no relative imports).
    from: "node_modules/wa-sqlite/dist/wa-sqlite-async.mjs",
    to: "public/wa-sqlite/wa-sqlite-async.mjs",
  },
  {
    // The API/VFS modules import each other relatively, so the package's
    // src/ layout is mirrored under public/wa-sqlite/src/.
    from: "node_modules/wa-sqlite/src/sqlite-api.js",
    to: "public/wa-sqlite/src/sqlite-api.js",
  },
  {
    from: "node_modules/wa-sqlite/src/sqlite-constants.js",
    to: "public/wa-sqlite/src/sqlite-constants.js",
  },
  {
    from: "node_modules/wa-sqlite/src/VFS.js",
    to: "public/wa-sqlite/src/VFS.js",
  },
  {
    from: "node_modules/wa-sqlite/src/examples/IDBBatchAtomicVFS.js",
    to: "public/wa-sqlite/src/examples/IDBBatchAtomicVFS.js",
  },
  {
    from: "node_modules/wa-sqlite/src/examples/WebLocks.js",
    to: "public/wa-sqlite/src/examples/WebLocks.js",
  },
  {
    from: "node_modules/wa-sqlite/src/examples/IDBContext.js",
    to: "public/wa-sqlite/src/examples/IDBContext.js",
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

// A short SyncAccessHandle.read() (observed on iOS Safari) must not be
// misread as a bad digest: upstream answers that with
// setAssociatedPath("") + truncate, which empties a database that still
// holds data. Every legit pool file is >= SECTOR_SIZE (4096) bytes and the
// header block is only 516+8 bytes, so a short read of a file that is big
// enough is always the iOS bug — fail the init (the worker falls back to
// the IndexedDB engine) instead of destroying the file.
const PATCHES = [
  {
    file: "public/sqlite-wasm/sqlite3.mjs",
    from: "sah.read(this.#apBody, { at: 0 });",
    to: [
      "if (sah.read(this.#apBody, { at: 0 }) !== this.#apBody.byteLength) {",
      '\t\t\t\t\tif (sah.getSize() < this.#apBody.byteLength) return "";',
      '\t\t\t\t\ttoss("SAHPool: short header read of a non-empty file (iOS Safari short-read bug; vocleap patch)");',
      "\t\t\t\t}",
    ].join("\n"),
  },
  {
    file: "public/sqlite-wasm/sqlite3.mjs",
    from: "sah.read(fileDigest, { at: HEADER_OFFSET_DIGEST });",
    to: [
      "if (sah.read(fileDigest, { at: HEADER_OFFSET_DIGEST }) !== fileDigest.byteLength) {",
      '\t\t\t\t\tif (sah.getSize() < HEADER_OFFSET_DIGEST + HEADER_DIGEST_SIZE) return "";',
      '\t\t\t\t\ttoss("SAHPool: short digest read of a non-empty file (iOS Safari short-read bug; vocleap patch)");',
      "\t\t\t\t}",
    ].join("\n"),
  },
];

for (const { file, from, to } of PATCHES) {
  if (!existsSync(file)) {
    console.error(`Patching ${file}: file missing (copy step failed?)`);
    process.exit(1);
  }
  const contents = readFileSync(file, "utf8");
  const occurrences = contents.split(from).length - 1;
  if (occurrences !== 1) {
    console.error(
      `Patching ${file}: expected exactly 1 occurrence of the target, found ${occurrences}. Upstream layout changed — update the patch before shipping.`
    );
    process.exit(1);
  }
  writeFileSync(file, contents.replace(from, to));
  console.log(`patched ${file}: SAHPool short-read guard`);
}
