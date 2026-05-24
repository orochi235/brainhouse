import 'highlight.js/styles/github-dark.css';
import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useFilenameLinks } from '../lib/filenameLinksContext.tsx';
import { rehypeFilenameLinks } from '../lib/rehypeFilenameLinks.ts';
import { MermaidBlock } from './MermaidBlock.tsx';

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
      // biome-ignore lint/suspicious/noExplicitAny: rehype plugin tuple
      [rehypeHighlight, [rehypeFilenameLinks, { cwd, template }]] as any[],
    [cwd, template],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={MARKDOWN_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Intercept ```mermaid fences and route them to MermaidBlock. Other
 * code fences fall through to react-markdown's default `<code>` (which
 * rehypeHighlight has already syntax-painted). */
const MARKDOWN_COMPONENTS: Components = {
  code(props) {
    const { className, children } = props;
    if (typeof className === 'string' && /\blanguage-mermaid\b/.test(className)) {
      const source = String(children ?? '').replace(/\n$/, '');
      return <MermaidBlock source={source} />;
    }
    return <code {...props} />;
  },
};

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
