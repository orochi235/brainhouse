import { useState } from 'react';

/** Short, click-to-copy id chip. Shows the first 10 chars; on click,
 * copies the full id and briefly flashes "copied!". Used by the debug
 * tile and the processes dashboard so abbreviation + copy feel
 * uniform across the app. */
export function CopyableId({ id, length = 10 }: { id: string; length?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copyable-id${copied ? ' copied' : ''}`}
      title={`copy ${id}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(id);
        } catch {
          // clipboard write can fail in non-secure contexts; fall back silently
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 900);
      }}
    >
      <code>{copied ? 'copied!' : id.slice(0, length)}</code>
    </button>
  );
}
