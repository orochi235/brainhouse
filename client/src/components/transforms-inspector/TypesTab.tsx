/** Tab A controller. Owns search state; reads selection from props (hash route). */

import { useMemo, useState } from 'react';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { useSelectors } from '../../transforms/selectors/store.tsx';
import { TypeAuthoringSheet } from './TypeAuthoringSheet.tsx';
import { TypesDetail } from './TypesDetail.tsx';
import { TypesList } from './TypesList.tsx';

export function TypesTab({
  selectedKey,
  onSelect,
  onJumpToTransform,
}: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onJumpToTransform: (transformKey: string) => void;
}) {
  const { all, byKey, addUser } = useSelectors();
  const [search, setSearch] = useState('');
  const [authoring, setAuthoring] = useState(false);

  const filtered = useMemo(() => {
    const sorted = [...all].sort((a, b) => a.key.localeCompare(b.key));
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.key.toLowerCase().includes(q) ||
        s.selector.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [all, search]);

  const selected = selectedKey ? (byKey.get(selectedKey) ?? null) : null;
  const usedBy = useMemo(() => {
    if (!selected) return [];
    return VIEW_TRANSFORMS.filter((t) => t.matches?.includes(selected.key));
  }, [selected]);

  return (
    <div className="inspector-two-col">
      <TypesList
        entries={filtered}
        selectedKey={selectedKey}
        search={search}
        onSearch={setSearch}
        onSelect={onSelect}
        onAdd={() => setAuthoring(true)}
      />
      {authoring ? (
        <TypeAuthoringSheet
          onCancel={() => setAuthoring(false)}
          onSave={(def) => {
            addUser(def);
            setAuthoring(false);
            onSelect(def.key);
          }}
        />
      ) : (
        <TypesDetail
          def={selected}
          usedBy={usedBy}
          onJumpToTransform={onJumpToTransform}
        />
      )}
    </div>
  );
}
