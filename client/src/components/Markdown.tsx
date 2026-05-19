import 'highlight.js/styles/github-dark.css';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

interface Props {
  text: string;
  /** Escape any raw HTML in the source before rendering. */
  escape?: boolean;
}

/**
 * GFM markdown via react-markdown with syntax-highlighted code blocks.
 *
 * For user text we set `escape = true` so any literal `<hr>` or other HTML
 * the user types renders as text rather than as markup. react-markdown does
 * not parse raw HTML by default (no rehype-raw), so this is mostly defense-
 * in-depth, but it also strips backslashes/etc consistently.
 */
export function Markdown({ text, escape }: Props) {
  const source = escape ? escapeHtml(text) : text;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}
