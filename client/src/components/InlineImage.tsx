/**
 * Thumbnail for an image lifted out of a transcript record. Clicking opens
 * the full-size picture in the lightbox. The bytes come from the server's
 * content-addressed cache; a ref with no `sha256` never made it there, so it
 * renders as a labeled placeholder instead of a broken `<img>`.
 */

import { type ImageRef, imageFileName } from '@server/parser.ts';
import { useLightbox } from '../lib/lightboxContext.ts';

export function imageUrl(ref: ImageRef): string | null {
  const name = imageFileName(ref);
  return name ? `/api/image/${name}` : null;
}

export function InlineImage({ image, alt }: { image: ImageRef; alt: string }) {
  const lightbox = useLightbox();
  const src = imageUrl(image);
  if (!src) return <span className="inline-image-missing">{alt} (bytes not cached)</span>;
  return (
    <button
      type="button"
      className="inline-image"
      title={`${alt} — ${formatBytes(image.bytes)}`}
      onClick={(e) => {
        e.stopPropagation();
        lightbox.open(<img className="lightbox-image" src={src} alt={alt} />);
      }}
    >
      <img src={src} alt={alt} loading="lazy" />
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
