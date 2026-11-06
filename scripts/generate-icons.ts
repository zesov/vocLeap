import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";

// Usage: node scripts/generate-icons.ts [out-1024.png]
// 1) Always: rebuild app/favicon.ico (16/32/48) from the master SVG.
// 2) If an output path argument is given: also write a 1024x1024 PNG
//    for `tauri icon` consumption.

const MASTER = "public/icons/icon-512.svg";
const out1024 = process.argv[2];

const svgBuf = readFileSync(MASTER);

// high density => librsvg renders large, then downscale = clean antialiasing
const raster = (size: number) => sharp(svgBuf, { density: 300 }).resize(size, size).png();

const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map((s) => raster(s).toBuffer()));

// Pack PNGs into a single .ico (Vista+ supports PNG-compressed entries)
const count = sizes.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(count, 4);

const entries: Buffer[] = [];
let offset = 6 + 16 * count;
pngs.forEach((png, i) => {
  const s = sizes[i];
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); // width  (0 = 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1); // height (0 = 256)
  e.writeUInt8(0, 2); // palette color count
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8); // data size
  e.writeUInt32LE(offset, 12); // data offset
  offset += png.length;
  entries.push(e);
});

writeFileSync("app/favicon.ico", Buffer.concat([header, ...entries, ...pngs]));

if (out1024) {
  await raster(1024).toFile(out1024);
}

console.log(`favicon.ico written (${sizes.join("/")} px)` + (out1024 ? `; ${out1024} written` : ""));
