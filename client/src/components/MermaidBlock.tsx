/**
 * Renders a fenced ```mermaid block as an SVG diagram via the mermaid
 * library, dynamic-imported on first use so it doesn't bloat the main
 * bundle until a transcript actually contains a diagram.
 *
 * Render errors (invalid syntax) fall back silently to a highlighted
 * source block so content is never lost.
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  source: string;
}

// Module-level cache of the mermaid singleton + a unique-id counter so
// repeated diagrams in the same panel don't collide.
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
let idCounter = 0;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    return m.default;
  });
  return mermaidPromise;
}

export function MermaidBlock({ source }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mermaid-${++idCounter}`);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then(async (mermaid) => {
        try {
          // parse() throws on invalid syntax; render() also throws but
          // also leaves debris in the DOM, so we gate on parse() first.
          await mermaid.parse(source);
          const { svg } = await mermaid.render(idRef.current, source);
          if (!cancelled) setSvg(svg);
        } catch {
          if (!cancelled) setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{source}</code>
      </pre>
    );
  }
  if (svg === null) {
    return <pre className="mermaid-loading">{source}</pre>;
  }
  return (
    <div
      className="mermaid-diagram"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid SVG output, securityLevel:strict.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
