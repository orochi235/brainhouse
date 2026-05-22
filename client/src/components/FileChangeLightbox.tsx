/**
 * Zoomed-in view of a coalesced file-change. Each op renders chronologically:
 *   - Read:      tiny "read N lines" note
 *   - Edit:      a unified-diff style hunk (old_string above, new_string below)
 *   - MultiEdit: each sub-edit as its own hunk
 *   - Write:     the new file content as one big "all replaced" hunk
 */

import { LinkifyText } from '../lib/filenameLinksContext.tsx';
import type { FileChangeItem } from '../lib/pipeline.ts';
import { OpView, summarizeFileChange } from './fileOpView.tsx';

export function FileChangeLightbox({ item }: { item: FileChangeItem }) {
  return (
    <div className="file-change-lightbox">
      <h3 className="lightbox-title">
        <LinkifyText text={item.path} />
      </h3>
      <p className="file-change-subtitle">
        {item.ops.length} operations · {summarizeFileChange(item)}
      </p>
      <div className="file-change-hunks">
        {item.ops.map((op, i) => (
          <OpView key={`${op.anchorUuid}-${i}`} op={op} />
        ))}
      </div>
    </div>
  );
}
