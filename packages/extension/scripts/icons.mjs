// Draws the backpack icon at each size Chrome uses and writes icons/*.png.
// Shapes are in a 0-1 square; each pixel is supersampled 4x4 for smooth edges.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const COLORS = { strap: hex("#7A4A1C"), body: hex("#E0A458"), flap: hex("#B9772E"), pocket: hex("#C98A3E"), buckle: hex("#FBE7C6") };

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** The color at a point, painted back to front; null is transparent. */
function paint(x, y) {
  let color = null;
  const d = Math.hypot(x - 0.5, y - 0.2);
  if (y < 0.22 && d <= 0.13 && d >= 0.075) color = COLORS.strap; // carry handle
  if (inRoundRect(x, y, 0.17, 0.2, 0.83, 0.94, 0.15)) color = y < 0.47 ? COLORS.flap : COLORS.body;
  if (inRoundRect(x, y, 0.3, 0.6, 0.7, 0.85, 0.07)) color = COLORS.pocket;
  if (inRoundRect(x, y, 0.445, 0.39, 0.555, 0.53, 0.025)) color = COLORS.buckle;
  return color;
}

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size) {
  const S = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const c = paint((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      if (a) row.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((255 * a) / (S * S))], 1 + px * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(join(out, `icon-${size}.png`), png(size));
console.log(`Wrote icons to ${out}`);
