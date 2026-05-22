import classNames from 'classnames';
import {
  FilenameLinksProvider,
  LinkifyText,
  useFilenameLinks,
} from '../lib/filenameLinksContext.tsx';
import { useLightbox } from '../lib/lightbox.tsx';
import type { ViewItem } from '../lib/pipeline.ts';
import { iconForTool, stringifyToolValue, summarizeTool } from '../lib/tools.ts';
import { EventTime } from './EventList.tsx';
import { Markdown } from './Markdown.tsx';

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
    <li className={classNames('event event-tool', item.canceled && 'canceled')}>
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
          {icon.kind === 'svg' ? (
            <span
              className="svg-glyph"
              aria-hidden="true"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
              dangerouslySetInnerHTML={{ __html: icon.svg }}
            />
          ) : (
            icon.text
          )}
        </span>
        <span className="tool-label">
          <LinkifyText text={label} />
        </span>
        <span className={`tool-status status-${status}`} aria-label={status}>
          {status === 'pending' ? '' : status === 'ok' ? '✓' : '✗'}
        </span>
      </div>
      {/* Time lives as a sibling of the capsule (not inside it) so its
       * absolute positioning anchors to the `.event` li — same right-edge
       * alignment as every other log entry. */}
      <EventTime ts={item.ts} startedAt={startedAt} />
      {item.ack && (
        <div className="tool-note">
          <Markdown text={item.ack} />
        </div>
      )}
    </li>
  );
}

function ToolLightboxContent({ item }: { item: ToolItem }) {
  const use = item.use;
  const result = item.result;
  return (
    <>
      <h3 className="lightbox-title">{use?.name ?? 'tool'}</h3>
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
