/**
 * React context that gives downstream renderers the panel cwd + the user's
 * editor URL template, so anywhere in the panel subtree can turn a raw
 * filename string into a clickable deeplink.
 *
 * Two consumers:
 *   - <LinkifyText> — for non-markdown plain-text contexts (capsule labels,
 *     <pre> bodies in the lightbox, file-change row paths)
 *   - the rehype plugin used inside <Markdown> — pulled from this context
 *     via the Markdown component
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  buildEditorUrl,
  DEFAULT_EDITOR_TEMPLATE,
  resolveAbsolute,
  segmentFilenameLinks,
} from './filenameLinks.ts';

export interface FilenameLinksConfig {
  cwd: string | null;
  template: string;
}

const FilenameLinksContext = createContext<FilenameLinksConfig>({
  cwd: null,
  template: DEFAULT_EDITOR_TEMPLATE,
});

export function FilenameLinksProvider({
  cwd,
  template,
  children,
}: FilenameLinksConfig & { children: ReactNode }) {
  const value = useMemo(() => ({ cwd, template }), [cwd, template]);
  return <FilenameLinksContext.Provider value={value}>{children}</FilenameLinksContext.Provider>;
}

export function useFilenameLinks(): FilenameLinksConfig {
  return useContext(FilenameLinksContext);
}

/**
 * Render `text` with any path-shaped tokens turned into editor-deeplink
 * anchors. Used by non-markdown call sites. Clicking the link stops
 * propagation so it doesn't also trigger an enclosing row/capsule click.
 */
export function LinkifyText({ text }: { text: string }) {
  const { cwd, template } = useFilenameLinks();
  const segs = useMemo(() => segmentFilenameLinks(text), [text]);
  if (segs.length === 1 && segs[0].kind === 'text') return <>{text}</>;
  return (
    <>
      {segs.map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.value}</span>;
        const abs = resolveAbsolute(s.match.path, cwd);
        const href = buildEditorUrl(template, abs, s.match.line, s.match.col);
        if (!href) return <span key={i}>{s.match.raw}</span>;
        return (
          <a
            key={i}
            className="filename-link"
            href={href}
            title={`open ${abs}${s.match.line ? `:${s.match.line}` : ''} in editor`}
            onClick={(e) => e.stopPropagation()}
          >
            {s.match.raw}
          </a>
        );
      })}
    </>
  );
}
