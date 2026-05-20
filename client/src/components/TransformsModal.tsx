/**
 * Debug view of the event → view-item transforms applied by
 * `preprocessEvents()` (lib/pipeline.ts). Static metadata — kept colocated
 * with the modal so adding a new transform here is the prompt to update the
 * list. Render order matches the pipeline's execution order.
 */

interface TransformInfo {
  name: string;
  stage: 'pass-1' | 'pass-2';
  source: string;
  blurb: string;
}

const TRANSFORMS: TransformInfo[] = [
  {
    name: 'pending-indicator tracking',
    stage: 'pass-1',
    source: 'pipeline.ts',
    blurb:
      'Drives the thinking indicator + waiting badge. user_text / tool_result set pending=true; assistant_text / tool_use clear it.',
  },
  {
    name: 'checklist scan',
    stage: 'pass-1',
    source: 'pipeline.ts → extractLastChecklist',
    blurb:
      'Finds the most recent ```pensieve-checklist code block in any bubble and surfaces it as the panel\'s pinned progress list.',
  },
  {
    name: 'mergeToolResultIntoCapsule',
    stage: 'pass-1',
    source: 'pipeline.ts',
    blurb:
      'Attaches a tool_result onto the existing tool capsule with the same tool_use_id. Orphans (result with no use) render as a result-only capsule.',
  },
  {
    name: 'AskUserQuestion → assistant bubble',
    stage: 'pass-1',
    source: 'pipeline.ts → formatAskUserQuestion',
    blurb:
      'Renders an AskUserQuestion tool call as if Claude is speaking — bolded question + bulleted options. The matching tool_result is swallowed.',
  },
  {
    name: 'tool_use → new capsule',
    stage: 'pass-1',
    source: 'pipeline.ts',
    blurb:
      'Default tool_use handler: emits a `tool` view item. Special-cases the orphan-upgrade path when we already rendered a result-only capsule.',
  },
  {
    name: 'suppressInterruptMarker',
    stage: 'pass-1',
    source: 'pipeline.ts → markCanceledTurn',
    blurb:
      'Drops the synthetic "[Request interrupted by user]" user_text. Walks back to the last user bubble and marks every assistant/tool item between as canceled (dim + strikethrough).',
  },
  {
    name: 'mergeInterruptedFollowup',
    stage: 'pass-1',
    source: 'pipeline.ts',
    blurb:
      'If the user_text right after an interrupt isn\'t itself another interrupt, attach it to the previous user bubble with a sawtooth tear instead of starting a new bubble.',
  },
  {
    name: 'foldToolAck',
    stage: 'pass-1',
    source: 'pipeline.ts',
    blurb:
      'A short assistant_text immediately after a tool capsule is treated as an acknowledgement (e.g. "let me check the logs") and folded into the capsule footer.',
  },
  {
    name: 'coalesceFileOps',
    stage: 'pass-2',
    source: 'pipeline.ts',
    blurb:
      'Successive Read/Edit/Write/MultiEdit ops on the same file collapse into a single `file-change` row whose lightbox shows the cumulative diff.',
  },
  {
    name: 'coalesceBetweenChats',
    stage: 'pass-2',
    source: 'pipeline.ts',
    blurb:
      'A run of ≥2 non-bubble items (tool calls, file-changes, thinking) between two bubbles compresses into an `op-strip` row; click expands the lightbox.',
  },
];

export function TransformsModal() {
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline transforms</h3>
      <p className="transforms-intro">
        Event → view-item transforms applied by <code>preprocessEvents()</code>. Pass 1 walks the
        event list and emits view items; pass 2 reshapes them in-place.
      </p>
      <ol className="transforms-list">
        {TRANSFORMS.map((t) => (
          <li className={`transforms-item transforms-${t.stage}`} key={t.name}>
            <div className="transforms-row">
              <span className="transforms-name">{t.name}</span>
              <span className="transforms-stage">{t.stage}</span>
            </div>
            <div className="transforms-source">{t.source}</div>
            <p className="transforms-blurb">{t.blurb}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
