import classNames from 'classnames';
import {
  FilenameLinksProvider,
  LinkifyText,
  useFilenameLinks,
} from '../lib/filenameLinksContext.tsx';
import { useLightbox } from '../lib/lightboxContext.ts';
import type { ViewItem } from '../lib/pipeline.ts';
import { iconForTool, parseMcpToolName, stringifyToolValue, summarizeTool } from '../lib/tools.ts';
import { CapsuleRow } from './CapsuleRow.tsx';
import { Markdown } from './Markdown.tsx';
import { SvgGlyph } from './SvgGlyph.tsx';

type ToolItem = Extract<ViewItem, { type: 'tool' }>;

/**
 * Single-row tool capsule. Click → lightbox shows the input and result.
 */
export function ToolCapsule({ item, startedAt }: { item: ToolItem; startedAt?: number }) {
  const lightbox = useLightbox();
  const { cwd, template } = useFilenameLinks();
  const use = item.use ?? { tool_use_id: '', name: 'output', input: {} };
  const result = item.result;
  const status = result ? (result.is_error ? 'error' : 'ok') : 'pending';
  const label = summarizeTool(use, result);
  const icon = iconForTool(use.name, use.input);

  return (
    <CapsuleRow
      kind="tool"
      ts={item.ts}
      startedAt={startedAt}
      className={classNames(item.canceled && 'canceled')}
      trailing={
        <span className={`tool-status status-${status}`} aria-label={status}>
          {status === 'pending' ? '' : status === 'ok' ? '✓' : '✗'}
        </span>
      }
    >
      <div
        className={classNames('tool-capsule', status, item.canceled && 'canceled')}
        data-tool-name={use.name}
        onClick={() =>
          lightbox.open(
            <FilenameLinksProvider cwd={cwd} template={template}>
              <ToolLightboxContent item={item} />
            </FilenameLinksProvider>,
          )
        }
      >
        <span className="tool-icon">
          {icon.kind === 'svg' ? <SvgGlyph svg={icon.svg} className="svg-glyph" /> : icon.text}
        </span>
        <span className="tool-label" title={label}>
          <LinkifyText text={label} />
        </span>
      </div>
      {item.ack && (
        <div className="tool-note">
          <Markdown text={item.ack} />
        </div>
      )}
    </CapsuleRow>
  );
}

function ToolLightboxContent({ item }: { item: ToolItem }) {
  const use = item.use;
  const result = item.result;
  const mcp = use ? parseMcpToolName(use.name) : null;
  return (
    <>
      <h3 className="lightbox-title" title={use?.name}>
        {mcp ? `${mcp.server} · ${mcp.tool}` : (use?.name ?? 'tool')}
      </h3>
      {use && (
        <>
          <div className="lightbox-section">input</div>
          <pre className="lightbox-code">
            <LinkifyText text={stringifyToolValue(use.input)} />
          </pre>
        </>
      )}
      {result ? (
        <>
          <div className="lightbox-section">{result.is_error ? 'result (error)' : 'result'}</div>
          <pre className="lightbox-code">
            <LinkifyText text={stringifyToolValue(result.content)} />
          </pre>
        </>
      ) : (
        <div className="lightbox-section">result pending…</div>
      )}
      {item.prelude && (
        <>
          <div className="lightbox-section">skill content</div>
          <pre className="lightbox-code">
            <LinkifyText text={item.prelude} />
          </pre>
        </>
      )}
    </>
  );
}
