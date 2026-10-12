// PDFs for the tests, made when they run: a blank page, and a page with a QR
// code drawn as filled squares (qrencode gives the modules). Nothing binary
// is kept in the repository.
import { execFileSync } from 'node:child_process';

/** One page of `size` points square with `content` as its drawing. */
function onePage(content, size) {
  const stream = Buffer.from(content, 'latin1');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${size} ${size}]/Contents 4 0 R>>`,
    `<</Length ${stream.length}>>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const blankPdf = () => onePage('', 200);

/** A page with `text` as a QR code, 4 points a module. */
export function qrPdf(text) {
  const rows = execFileSync('qrencode', ['-t', 'ASCII', '-m', '4', '-l', 'M'], { input: text, encoding: 'utf8' }).split('\n').filter(Boolean);
  const n = rows.length;
  const squares = [];
  rows.forEach((row, y) => {
    for (let x = 0; x * 2 < row.length; x++) if (row[x * 2] === '#') squares.push(`${x * 4} ${(n - 1 - y) * 4} 4 4 re`);
  });
  return onePage(`0 g\n${squares.join('\n')}\nf`, n * 4);
}
