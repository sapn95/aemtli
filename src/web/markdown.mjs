// Results are Markdown (goose writes tables, lists, headings), and an agent
// wrote them, possibly after reading something hostile. So: no raw HTML at
// all, links only to the schemes markdown-it allows (no javascript:), links
// open in a new tab without a referrer, and images are not loaded but named.
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
const linkOpen = md.renderer.rules.link_open ?? renderToken;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
  tokens[idx].attrSet('target', '_blank');
  return linkOpen(tokens, idx, options, env, self);
};
// An image would be fetched from wherever the agent pointed, which the CSP
// refuses anyway; saying what it is beats a broken picture.
md.renderer.rules.image = (tokens, idx) => {
  const alt = md.utils.escapeHtml(tokens[idx].content || 'image');
  return `<span class="md-image">[${alt}]</span>`;
};

/** Renders a run's result as HTML that is safe to put into the page. */
export function renderMarkdown(text) {
  return md.render(String(text ?? ''));
}
