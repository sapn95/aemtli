import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { ICONS, iconPng, encodePng, crc32, PNG_SIGNATURE } from '../src/web/icon.mjs';

/** The chunks of a PNG, each checked against its CRC. */
function chunks(png) {
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  const out = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `CRC of ${type}`);
    out.push({ type, data });
    at += 12 + length;
  }
  return out;
}

/** Width, height and the RGBA pixels of a PNG this module wrote. */
function decode(png) {
  const all = chunks(png);
  assert.deepEqual(all.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  const header = all[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0], '8-bit RGBA, not interlaced');
  const raw = inflateSync(all[1].data);
  assert.equal(raw.length, (width * 4 + 1) * height);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'no filter');
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, at: (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

test('the CRC is the one PNG and zlib use', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('a PNG holds exactly the pixels it was given', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const { width, height, at } = decode(encodePng(3, 2, rgba));
  assert.deepEqual([width, height], [3, 2]);
  assert.deepEqual(at(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(1, 0), [0, 255, 0, 128]);
  assert.deepEqual(at(2, 1), [9, 10, 11, 12]);
});

test('every icon has its size, and only full-bleed ones are opaque to the corner', () => {
  assert.deepEqual(Object.keys(ICONS).sort(), ['apple-touch-icon.png', 'badge-96.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']);
  for (const [name, spec] of Object.entries(ICONS).filter(([, spec]) => !spec.badge)) {
    const { width, height, at } = decode(iconPng(name));
    assert.deepEqual([width, height], [spec.size, spec.size], name);
    assert.equal(at(0, 0)[3], spec.bleed ? 255 : 0, `${name}: corner`);
    assert.equal(at(spec.size - 1, spec.size - 1)[3], spec.bleed ? 255 : 0, `${name}: other corner`);
    // Paper in the middle of an edge, where no line and no tick passes.
    assert.deepEqual(at(Math.round(spec.size * 0.05), Math.round(spec.size / 2)), [0xf5, 0xf7, 0xf8, 255], `${name}: paper`);
  }
});

test('the tick is blue where icon.svg draws it, and stays in a maskable icon\'s safe zone', () => {
  const blue = ([r, g, b]) => b > 200 && r < 80 && g < 110;
  // The tick's bend, at (13, 22.5) of 32 units.
  const any = decode(iconPng('icon-512.png'));
  assert.ok(blue(any.at(Math.round(13 / 32 * 512), Math.round(22.5 / 32 * 512))));
  assert.ok(!blue(any.at(256, 60)), 'above the tick there is paper');
  // A launcher may cut a maskable icon to a circle of 80 per cent: nothing of
  // the tick may lie outside it.
  const mask = decode(iconPng('icon-maskable-512.png'));
  let outside = 0;
  let inside = 0;
  for (let y = 0; y < 512; y += 2) {
    for (let x = 0; x < 512; x += 2) {
      if (!blue(mask.at(x, y))) continue;
      if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 0.4 * 512) outside += 1;
      else inside += 1;
    }
  }
  assert.equal(outside, 0);
  assert.ok(inside > 1000, 'and the tick is there');
});

test('the notification badge is the tick alone, white on nothing', () => {
  const badge = decode(iconPng('badge-96.png'));
  assert.deepEqual([badge.width, badge.height], [96, 96]);
  assert.equal(badge.at(0, 0)[3], 0, 'no paper in the corner');
  assert.equal(badge.at(48, 4)[3], 0, 'nor above the tick');
  assert.deepEqual(badge.at(Math.round(13 / 32 * 96), Math.round(22.5 / 32 * 96)), [255, 255, 255, 255], 'the bend of the tick');
});

test('an icon is drawn once, and only the names listed are drawn at all', () => {
  assert.equal(iconPng('icon-192.png'), iconPng('icon-192.png'));
  assert.equal(iconPng('icon.svg'), null);
  assert.equal(iconPng('../app.css'), null);
  assert.equal(iconPng('constructor'), null);
});
