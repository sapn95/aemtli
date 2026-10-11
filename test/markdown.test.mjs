import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/web/markdown.mjs';

test('Markdown renders headings, lists and tables', () => {
  const html = renderMarkdown('# Release watch\n\n- goose 1.55.0\n- k3s v1.36.6\n\n| Tool | Version |\n|---|---|\n| goose | 1.55.0 |\n');
  assert.match(html, /<h1>Release watch<\/h1>/);
  assert.match(html, /<li>goose 1\.55\.0<\/li>/);
  assert.match(html, /<th>Tool<\/th>/);
});

test('what an agent wrote cannot run script, load anything or keep the referrer', () => {
  const html = renderMarkdown([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)',
    '[a](JaVaScRiPt:alert(1)) [b](&#106;avascript:alert(1)) [c](java%0ascript:alert(1)) [d](vbscript:x)',
    '![tracker](https://evil.example/pixel.png)',
    '[ok](https://example.com/a?b=c) and https://example.org',
  ].join('\n\n'));
  assert.doesNotMatch(html, /<script|<img|<[^>]*onerror=|href="(java|vb)script:|href="data:/i);
  // Whatever survives as a link resolves to http(s), as a browser reads it.
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    assert.match(new URL(href.replaceAll('&amp;', '&'), 'https://aemtli.example/').protocol, /^https?:$/, href);
  }
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<span class="md-image">\[tracker\]<\/span>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=c" rel="noopener noreferrer nofollow" target="_blank">ok<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.org" rel="noopener noreferrer nofollow" target="_blank">/, 'bare links become links too');
});

test('an image alt text is escaped, and nothing is an empty string', () => {
  assert.match(renderMarkdown('![<b>x</b>](https://a.example/i.png)'), /\[&lt;b&gt;x&lt;\/b&gt;\]/);
  assert.equal(renderMarkdown(undefined), '');
});
