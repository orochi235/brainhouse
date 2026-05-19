/**
 * Render a one-line title-ish string with backtick-delimited segments
 * turned into <code>. Pairs unescaped backticks; an unpaired trailing
 * backtick is rendered as a literal `.
 *
 * Why this exists: panel titles come from the user's first prompt, so they
 * often contain things like "fix the `useEffect` cleanup" that look wrong
 * with raw backticks in the UI. Full markdown is overkill — we just want
 * inline code.
 */
import type { ReactNode } from 'react';

export function renderInlineCode(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let inCode = false;
  let key = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') {
      if (inCode) {
        out.push(
          <code key={key++} className="inline-code">
            {buf}
          </code>,
        );
      } else if (buf) {
        out.push(buf);
      }
      buf = '';
      inCode = !inCode;
      continue;
    }
    buf += ch;
  }
  if (buf) {
    // Trailing unpaired backtick: emit the buffer as plain text, prefixed
    // with the backtick we never closed.
    out.push(inCode ? `\`${buf}` : buf);
  }
  return out;
}
