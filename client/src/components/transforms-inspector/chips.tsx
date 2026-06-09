/**
 * Compact chip rendering a selector key. Used in both Tab A's "Used by"
 * (jumps to Transforms tab) and Tab B's "Matches" list (jumps to Types
 * tab). When the key is missing from the store, the chip renders with a
 * trailing "?" badge and a tooltip — surfaces drift rather than hiding.
 */

import { useSelectors } from '../../transforms/selectors/store.tsx';

export function SelectorKeyChip({
  selectorKey,
  onClick,
}: {
  selectorKey: string;
  onClick?: () => void;
}) {
  const { byKey } = useSelectors();
  const def = byKey.get(selectorKey);
  const missing = !def;
  return (
    <button
      type="button"
      className={`inspector-chip${missing ? ' inspector-chip-missing' : ''}`}
      onClick={onClick}
      title={missing ? 'selector not in registry' : def?.description || selectorKey}
    >
      <span className="inspector-chip-key">{selectorKey}</span>
      {missing && (
        <span className="inspector-chip-badge" aria-label="missing selector">
          ?
        </span>
      )}
    </button>
  );
}

export function TransformKeyChip({
  transformKey,
  name,
  onClick,
}: {
  transformKey: string;
  name?: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" className="inspector-chip" onClick={onClick} title={transformKey}>
      <span className="inspector-chip-key">{name ?? transformKey}</span>
    </button>
  );
}
