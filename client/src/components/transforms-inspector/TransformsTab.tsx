import { useMemo, useState } from 'react';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { TransformsDetail } from './TransformsDetail.tsx';
import { TransformsList } from './TransformsList.tsx';

export function TransformsTab({
  selectedKey,
  onSelect,
  onJumpToType,
}: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onJumpToType: (selectorKey: string) => void;
}) {
  const [search, setSearch] = useState('');
  const entries = useMemo(() => {
    if (!search) return VIEW_TRANSFORMS;
    const q = search.toLowerCase();
    return VIEW_TRANSFORMS.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.matches ?? []).some((k) => k.toLowerCase().includes(q)),
    );
  }, [search]);
  const selected = selectedKey
    ? (VIEW_TRANSFORMS.find((t) => t.key === selectedKey) ?? null)
    : null;
  return (
    <div className="inspector-two-col">
      <TransformsList
        entries={entries}
        selectedKey={selectedKey}
        search={search}
        onSearch={setSearch}
        onSelect={onSelect}
      />
      <TransformsDetail transform={selected} onJumpToType={onJumpToType} />
    </div>
  );
}
