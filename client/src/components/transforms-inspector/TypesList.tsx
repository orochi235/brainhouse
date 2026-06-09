/** Left column for the Types tab — search + selectable row per SelectorDef. */

import type { StoredSelectorDef } from '../../transforms/selectors/store.tsx';

export function TypesList({
  entries,
  selectedKey,
  search,
  onSearch,
  onSelect,
  onAdd,
}: {
  entries: StoredSelectorDef[];
  selectedKey: string | null;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (key: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="inspector-list">
      <div className="inspector-list-header">
        <input
          type="search"
          placeholder="search types…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="inspector-search"
        />
        <button type="button" className="inspector-add" onClick={onAdd}>
          + Add type
        </button>
      </div>
      {entries.length === 0 && <p className="inspector-list-empty">no matches</p>}
      <ul className="inspector-list-rows">
        {entries.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              className={`inspector-list-row${s.key === selectedKey ? ' is-selected' : ''}`}
              onClick={() => onSelect(s.key)}
            >
              <span className="inspector-list-name">
                {s.name}
                {s.origin === 'user' && <span className="inspector-badge-user">user</span>}
              </span>
              <span className="inspector-list-key">{s.key}</span>
              <span className="inspector-list-desc">{s.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
