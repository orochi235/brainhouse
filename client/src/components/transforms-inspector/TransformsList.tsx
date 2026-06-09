import type { ViewTransform } from '../../transforms/types.ts';

const MAX_VISIBLE_CHIPS = 2;

export function TransformsList({
  entries,
  selectedKey,
  search,
  onSearch,
  onSelect,
}: {
  entries: ViewTransform[];
  selectedKey: string | null;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="inspector-list">
      <div className="inspector-list-header">
        <input
          type="search"
          placeholder="search transforms…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="inspector-search"
        />
      </div>
      <ul className="inspector-list-rows">
        {entries.map((t) => {
          const matches = t.matches ?? [];
          const visible = matches.slice(0, MAX_VISIBLE_CHIPS);
          const overflow = matches.length - visible.length;
          const views = t.views ? t.views.join(', ') : 'all';
          return (
            <li key={t.key}>
              <button
                type="button"
                className={`inspector-list-row inspector-transforms-row${
                  t.key === selectedKey ? ' is-selected' : ''
                }`}
                onClick={() => onSelect(t.key)}
              >
                <span className="inspector-list-name">{t.name}</span>
                <span className="inspector-list-key">{t.key}</span>
                <span className={`inspector-stage inspector-stage-${t.stage}`}>
                  stage {t.stage}
                </span>
                <span className="inspector-views">{views}</span>
                <span className="inspector-list-chips">
                  {visible.map((k) => (
                    <span key={k} className="inspector-chip-mini">
                      {k}
                    </span>
                  ))}
                  {overflow > 0 && (
                    <span className="inspector-chip-overflow">+{overflow}</span>
                  )}
                </span>
                <span className="inspector-list-desc">{t.description}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
