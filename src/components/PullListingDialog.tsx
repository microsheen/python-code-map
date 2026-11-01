/**
 * 勾选清单模态（issue #6）。
 *
 * 受控展示组件：只持有「过滤词 / 勾了哪些路径」这类交互状态，不重复实现任何规则 ——
 * 可勾性（1MB 上限）来自 pullListing.entries.selectable，剩余配额由会话文件数推出来，
 * 两者在这里只决定复选框的 disabled；真正的硬顶仍由 store 的 confirmPullListing 兜底。
 *
 * 与 FeedbackDialog 一样用原生 div / input：AppRoot 已经有原生覆盖层的先例，而且清单行
 * 需要原生 label/checkbox 的键盘与鼠标行为（RN-web 的 Pressable 不转发这些）。
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { MAX_FILES, listingQuota, useAppStore } from '../state/store';
import { MAX_FILE_SIZE } from '../parser/analyze';
import { colors, fonts, spacing } from '../theme';

/** 清单里的体积：与单文件上限共用同一个常数（1 MB = 1024²），不另立一份判据。 */
function formatSize(bytes: number): string {
  if (bytes >= MAX_FILE_SIZE) return (bytes / MAX_FILE_SIZE).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: colors.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const panelStyle: CSSProperties = {
  background: colors.panel,
  border: '1px solid ' + colors.borderStrong,
  borderRadius: 12,
  width: 640,
  maxWidth: '92vw',
  maxHeight: '86vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  fontFamily: fonts.ui,
  color: colors.text,
};

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.md,
  padding: spacing.xl + 'px ' + spacing.xl + 'px ' + spacing.sm + 'px',
  flexShrink: 0,
};

const titleStyle: CSSProperties = { fontSize: 17, fontWeight: 700, flex: 1 };

const subtitleStyle: CSSProperties = {
  fontSize: 12,
  color: colors.dim,
  margin: '0 ' + spacing.xl + 'px ' + spacing.sm + 'px',
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  padding: '0 ' + spacing.xl + 'px ' + spacing.sm + 'px',
  flexShrink: 0,
};

const filterStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid ' + colors.border,
  background: colors.bg,
  color: colors.text,
  fontFamily: fonts.mono,
  fontSize: 12,
};

const smallBtnStyle: CSSProperties = {
  background: colors.raised,
  color: colors.dim,
  border: '1px solid ' + colors.border,
  borderRadius: 6,
  padding: '5px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const quotaStyle: CSSProperties = {
  fontSize: 11.5,
  color: colors.dim,
  padding: '0 ' + spacing.xl + 'px ' + spacing.sm + 'px',
  flexShrink: 0,
};

/** 清单自己滚：文件再多，底部两枚按钮也留在可视区。 */
const listStyle: CSSProperties = {
  overflowY: 'auto',
  flex: 1,
  minHeight: 60,
  borderTop: '1px solid ' + colors.border,
  borderBottom: '1px solid ' + colors.border,
};

const rowBaseStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  padding: '5px 10px 5px ' + spacing.xl + 'px',
  fontSize: 12.5,
  cursor: 'pointer',
  userSelect: 'none',
};

const pathStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: fonts.mono,
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const sizeStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 11.5,
  color: colors.dim,
  fontFamily: fonts.mono,
};

const emptyStyle: CSSProperties = {
  padding: spacing.xl,
  fontSize: 12.5,
  color: colors.dim,
  textAlign: 'center',
};

const footStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  padding: spacing.md + 'px ' + spacing.xl + 'px ' + spacing.lg + 'px',
  flexShrink: 0,
};

const progressStyle: CSSProperties = { flex: 1, fontSize: 12, color: colors.dim };

const primaryBtnStyle: CSSProperties = {
  background: colors.accentDim,
  color: colors.onAccent,
  border: '1px solid ' + colors.accent,
  borderRadius: 6,
  padding: '7px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const disabledBtnStyle: CSSProperties = { opacity: 0.6, cursor: 'default' };

export function PullListingDialog(): ReactNode {
  const listing = useAppStore((s) => s.pullListing);
  const files = useAppStore((s) => s.files);
  const pulling = useAppStore((s) => s.pulling);
  const progress = useAppStore((s) => s.pullProgress);
  const confirm = useAppStore((s) => s.confirmPullListing);
  const dismiss = useAppStore((s) => s.dismissPullListing);

  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  // 清单换代（新 URL 出清单 / 关闭后重开）时清空交互状态：open 翻 false->true 那一帧就清，
  // 放进 effect 会先画一帧上一份清单的勾选状态（FeedbackDialog 的 wasOpen 同理）。
  const sourceUrl = listing?.sourceUrl ?? null;
  const [wasSourceUrl, setWasSourceUrl] = useState<string | null>(null);
  if (sourceUrl !== wasSourceUrl) {
    setWasSourceUrl(sourceUrl);
    setFilter('');
    setSelected([]);
  }

  useEffect(() => {
    if (!listing) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !useAppStore.getState().pulling) dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [listing, dismiss]);

  if (!listing) return null;

  // 配额判据只在 store.listingQuota 里写一份：界面只消费它，不重复实现。
  const { remaining, isExisting } = listingQuota(files, listing);
  const newSelected = selected.filter((p) => !isExisting(p)).length;
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? listing.entries.filter((e) => e.path.toLowerCase().includes(needle))
    : listing.entries;

  const toggle = (path: string): void => {
    setSelected((prev) => {
      if (prev.includes(path)) return prev.filter((p) => p !== path);
      if (!isExisting(path) && newSelected >= remaining) return prev;
      return [...prev, path];
    });
  };

  const selectAll = (): void => {
    let room = remaining - newSelected;
    const addable = visible.filter((e) => e.selectable && !selected.includes(e.path));
    const next: string[] = [];
    for (const entry of addable) {
      if (isExisting(entry.path)) next.push(entry.path);
      else if (room > 0) {
        next.push(entry.path);
        room -= 1;
      }
    }
    if (next.length > 0) setSelected((prev) => [...prev, ...next]);
  };

  const hasAddable = visible.some(
    (e) =>
      e.selectable && !selected.includes(e.path) && (isExisting(e.path) || newSelected < remaining)
  );

  const onConfirm = (): void => {
    if (selected.length === 0 || pulling) return;
    void confirm(selected);
  };

  const location = listing.owner + '/' + listing.repo + ' @ ' + listing.ref;
  const where = listing.dir ? ' · ' + listing.dir : '';

  return (
    <div
      style={overlayStyle}
      onClick={() => {
        if (!pulling) dismiss();
      }}
    >
      <div
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Select files to pull"
        data-testid="pull-listing-dialog"
      >
        <div style={headStyle}>
          <div style={titleStyle}>Select files to pull</div>
          <button
            type="button"
            style={smallBtnStyle}
            onClick={() => {
              if (!pulling) dismiss();
            }}
            aria-label="Close"
            title="Close"
            data-testid="pull-listing-close"
            disabled={pulling}
          >
            {'✕'}
          </button>
        </div>
        <div style={subtitleStyle}>
          {location}
          {where}
        </div>

        <div style={toolbarStyle}>
          <input
            style={filterStyle}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by path…"
            aria-label="Filter by path"
            spellCheck={false}
            data-testid="pull-listing-filter"
          />
          <button
            type="button"
            style={smallBtnStyle}
            onClick={selectAll}
            disabled={pulling || !hasAddable}
            data-testid="pull-listing-select-all"
          >
            Select all
          </button>
          <button
            type="button"
            style={smallBtnStyle}
            onClick={() => setSelected([])}
            disabled={pulling || selected.length === 0}
            data-testid="pull-listing-clear"
          >
            Clear
          </button>
        </div>

        <div style={quotaStyle} data-testid="pull-listing-quota">
          {'Selected ' +
            selected.length +
            ' · ' +
            remaining +
            ' of ' +
            MAX_FILES +
            ' slots left in this session'}
        </div>

        <div style={listStyle} data-testid="pull-listing-list">
          {visible.length === 0 ? (
            <div style={emptyStyle} data-testid="pull-listing-empty">
              {listing.entries.length === 0
                ? 'No .py / .pyi files in this repository or directory.'
                : 'No .py / .pyi files match that filter.'}
            </div>
          ) : (
            visible.map((entry) => {
              const checked = selected.includes(entry.path);
              const full = !checked && !isExisting(entry.path) && newSelected >= remaining;
              const disabled = !entry.selectable || full;
              return (
                <div
                  key={entry.path}
                  style={{
                    ...rowBaseStyle,
                    opacity: entry.selectable ? 1 : 0.5,
                    cursor: disabled ? 'default' : 'pointer',
                  }}
                  role="checkbox"
                  aria-checked={checked}
                  aria-disabled={disabled}
                  onClick={() => {
                    if (!disabled) toggle(entry.path);
                  }}
                  data-testid={'pull-listing-row-' + entry.path}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(entry.path)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={entry.path}
                    data-testid={'pull-listing-check-' + entry.path}
                  />
                  <span style={pathStyle} title={entry.path}>
                    {entry.path}
                  </span>
                  <span style={sizeStyle} data-testid={'pull-listing-size-' + entry.path}>
                    {formatSize(entry.size)}
                    {entry.selectable ? '' : ' · over 1 MB'}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div style={footStyle}>
          <div style={progressStyle} data-testid="pull-listing-progress">
            {pulling ? 'Pulling ' + progress.done + ' / ' + progress.total : ''}
          </div>
          <button
            type="button"
            style={smallBtnStyle}
            onClick={() => dismiss()}
            disabled={pulling}
            data-testid="pull-listing-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            style={{
              ...primaryBtnStyle,
              ...(pulling || selected.length === 0 ? disabledBtnStyle : {}),
            }}
            onClick={onConfirm}
            disabled={pulling || selected.length === 0}
            data-testid="pull-listing-confirm"
          >
            {pulling ? 'Pulling…' : 'Pull selected'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PullListingDialog;
