// The app icons as PNG, drawn here instead of kept as files: the repo takes
// no binary images (scripts/hygiene.mjs), and the motif of public/icon.svg
// is simple enough to draw. A square of squared paper and the blue tick that
// says a chore is done. Each pixel is coloured by how far its centre lies
// from each shape, which smooths the edges as well as a renderer would at
// these sizes. The PNG is written with node:zlib and a CRC32 of its own, so
// nothing new is installed for it.
import { deflateSync } from 'node:zlib';

const PAPER = [0xf5, 0xf7, 0xf8];
const LINE = [0xdd, 0xe5, 0xec];
const TICK = [0x2b, 0x4f, 0xd8];
// In the 32-unit grid of icon.svg.
const UNITS = 32;
const CORNER = 6;
const LINES = [11, 21];
const LINE_WIDTH = 1.5;
const TICK_POINTS = [[7.5, 17], [13, 22.5], [24.5, 9.5]];
const TICK_WIDTH = 5;

/**
 * The icons there are, by the name they are served under. `motif` is the
 * share of the side the 32-unit drawing takes. A full-bleed icon has paper
 * to its edges: iOS rounds an apple-touch-icon itself and paints what is
 * transparent black, and a maskable icon is cut to whatever shape the
 * launcher likes, so its tick stays inside the middle 80 per cent.
 */
export const ICONS = {
  'apple-touch-icon.png': { size: 180, bleed: true, motif: 0.86 },
  'icon-192.png': { size: 192, bleed: false, motif: 1 },
  'icon-512.png': { size: 512, bleed: false, motif: 1 },
  'icon-maskable-512.png': { size: 512, bleed: true, motif: 0.72 },
};

const clamp = v => Math.min(1, Math.max(0, v));

/** Distance from (x, y) to the segment from a to b. */
function toSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Signed distance from (x, y) to a rounded square from 0 to `side`; negative inside. */
function toRoundedSquare(x, y, side, radius) {
  const half = side / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The icon's pixels, RGBA, row by row. */
export function draw({ size, bleed, motif }) {
  const scale = (size * motif) / UNITS;
  const offset = (size - size * motif) / 2;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      // The pixel's centre, in units of the drawing.
      const x = (px + 0.5 - offset) / scale;
      const y = (py + 0.5 - offset) / scale;
      // Coverage of each shape: half a pixel either side of its edge is the ramp.
      const cover = units => clamp(0.5 - units * scale);
      const paper = bleed ? 1 : clamp(0.5 - toRoundedSquare(px + 0.5, py + 0.5, size, CORNER * scale));
      const line = Math.max(...LINES.flatMap(at => [cover(Math.abs(x - at) - LINE_WIDTH / 2), cover(Math.abs(y - at) - LINE_WIDTH / 2)]));
      const tick = cover(Math.min(toSegment(x, y, TICK_POINTS[0], TICK_POINTS[1]), toSegment(x, y, TICK_POINTS[1], TICK_POINTS[2])) - TICK_WIDTH / 2);
      const at = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        const under = PAPER[c] + (LINE[c] - PAPER[c]) * line;
        pixels[at + c] = Math.round(under + (TICK[c] - under) * tick);
      }
      pixels[at + 3] = Math.round(255 * paper);
    }
  }
  return pixels;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC32 that PNG chunks carry (ISO 3309, as in zlib). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG of RGBA pixels, 8 bits a channel, every row unfiltered. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Bit depth 8, colour type 6 (RGBA), deflate, no filter method, no interlace.
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const drawn = new Map();

/** The PNG served as `name`, drawn on first use and kept; null for a name not in ICONS. */
export function iconPng(name) {
  if (!Object.hasOwn(ICONS, name)) return null;
  if (!drawn.has(name)) {
    const spec = ICONS[name];
    drawn.set(name, encodePng(spec.size, spec.size, draw(spec)));
  }
  return drawn.get(name);
}
