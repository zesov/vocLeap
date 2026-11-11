import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const ICONS_DIR = path.resolve("public/icons");
const SOURCES = [
  { src: "icon-192.svg", outputs: [{ file: "icon-192.png", size: 192 }, { file: "apple-touch-icon.png", size: 180 }] },
  { src: "icon-512.svg", outputs: [{ file: "icon-512.png", size: 512 }] },
];

await mkdir(ICONS_DIR, { recursive: true });

for (const { src, outputs } of SOURCES) {
  const input = path.join(ICONS_DIR, src);
  for (const { file, size } of outputs) {
    const output = path.join(ICONS_DIR, file);
    await sharp(input, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(output);
    console.log(`generated ${file} (${size}x${size})`);
  }
}
