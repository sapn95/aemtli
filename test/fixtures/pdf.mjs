// PDFs for the tests, made when they run: a blank page, and pages with a QR
// code each, drawn as filled squares (qrencode gives the modules). Nothing
// binary is kept in the repository.
import { execFileSync } from 'node:child_process';

/** A PDF with one page per { content, size }: `size` points square, `content` its drawing. */
function pdf(pages) {
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`];
  for (const [i, { content, size }] of pages.entries()) {
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${size} ${size}]/Contents ${4 + i * 2} 0 R>>`);
    objects.push(`<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`);
  }
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

export const blankPdf = () => pdf([{ content: '', size: 200 }]);

/** One page per text, each with the text as a QR code, 4 points a module. */
export function qrPdf(...texts) {
  return pdf(texts.map(text => {
    const rows = execFileSync('qrencode', ['-t', 'ASCII', '-m', '4', '-l', 'M'], { input: text, encoding: 'utf8' }).split('\n').filter(Boolean);
    const n = rows.length;
    const squares = [];
    rows.forEach((row, y) => {
      for (let x = 0; x * 2 < row.length; x++) if (row[x * 2] === '#') squares.push(`${x * 4} ${(n - 1 - y) * 4} 4 4 re`);
    });
    return { content: `0 g\n${squares.join('\n')}\nf`, size: n * 4 };
  }));
}
