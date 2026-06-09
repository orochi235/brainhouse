/**
 * Read-only TypeScript source block with a left-rail structural outline.
 * Clicking an outline entry scrolls the `<pre>` to that line. Highlight
 * via highlight.js (already a project dep); on parse failure, fall back
 * to plain text.
 */

import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import { useMemo, useRef } from 'react';
import { outline, type OutlineEntry } from './outline.ts';

hljs.registerLanguage('typescript', typescript);

export function SourceView({ source }: { source: string }) {
  const entries: OutlineEntry[] = useMemo(() => outline(source), [source]);
  const html = useMemo(() => {
    try {
      return hljs.highlight(source, { language: 'typescript' }).value;
    } catch {
      return escapeHtml(source);
    }
  }, [source]);
  const preRef = useRef<HTMLPreElement>(null);

  // Wrap highlighted HTML one line per row so the outline can address rows
  // by line number. We split on '\n' AFTER highlighting; highlight.js may
  // emit spans that wrap across newlines (e.g. block comments). To keep
  // line-addressing stable we tolerate broken markup by setting the
  // wrapper around the line text itself.
  const lineHtml = useMemo(() => {
    return html
      .split('\n')
      .map(
        (ln, i) => `<span class="src-line" data-line="${i + 1}">${ln || ' '}</span>`,
      )
      .join('\n');
  }, [html]);

  const scrollTo = (line: number) => {
    const pre = preRef.current;
    if (!pre) return;
    const target = pre.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="inspector-source">
      <nav className="inspector-source-outline" aria-label="Source outline">
        {entries.length === 0 ? (
          <span className="inspector-source-outline-empty">no outline</span>
        ) : (
          <ul>
            {entries.map((e) => (
              <li key={`${e.line}-${e.label}`} className={`inspector-outline-${e.kind}`}>
                <button type="button" onClick={() => scrollTo(e.line)}>
                  <span className="inspector-outline-line">L{e.line}</span>
                  <span className="inspector-outline-label">{e.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <pre ref={preRef} className="inspector-source-code">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js sanitizes its own output */}
        <code
          className="hljs language-typescript"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: see above
          dangerouslySetInnerHTML={{ __html: lineHtml }}
        />
      </pre>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
