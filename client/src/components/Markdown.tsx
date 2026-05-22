import 'highlight.js/styles/github-dark.css';
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useFilenameLinks } from '../lib/filenameLinksContext.tsx';
import { rehypeFilenameLinks } from '../lib/rehypeFilenameLinks.ts';

interface Props {
  text: string;
  /** Escape any raw HTML in the source before rendering. */
  escape?: boolean;
}

/**
 * GFM markdown via react-markdown with syntax-highlighted code blocks and
 * filename-link detection. Filename links are skipped inside <code>/<pre>
 * so verbatim snippets stay copy-pasteable.
 *
 * For user text we set `escape = true` so any literal `<hr>` or other HTML
 * the user types renders as text rather than as markup.
 */
export function Markdown({ text, escape }: Props) {
  const { cwd, template } = useFilenameLinks();
  const source = escape ? escapeHtml(text) : text;
  const rehypePlugins = useMemo(
    () =>
      [
        rehypeHighlight,
        [rehypeFilenameLinks, { cwd, template }],
      ] as ReadonlyArray<// biome-ignore lint/suspicious/noExplicitAny: rehype plugin tuple
      any>,
    [cwd, template],
  );
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
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
