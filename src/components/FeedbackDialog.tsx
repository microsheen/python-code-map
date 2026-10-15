/**
 * 反馈面板：受控展示组件。不写 store，也不订阅 store ——
 * 解析失败、恢复出旧会话这些降级态里，它同样必须能渲染（盯着旧版本看的人最需要报 bug）。
 *
 * 对外动作只有下面这两枚 a 的 href：页面自己不发起任何请求。诊断原料的白名单、
 * 计数化、长度上限全部收口在 src/feedback/contact.ts；本文件同样被
 * scripts/audit-egress.mjs 逐字扫描（注释也算），所以这里不出现任何请求原语。
 *
 * 用原生 div / a / textarea 而不是 RN 组件：AppRoot 已有原生 div 覆盖层先例，
 * 走原生 a 既不用为 href 做类型 cast，也让扫描器的 href= 判据成立。
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  CONTACT_EMAIL,
  buildDiagnosticsText,
  issuesHrefFor,
  mailHrefFor,
} from '../feedback/contact';
import { entryBuildStamp } from '../platform/web/buildStamp';
import { hasSession } from '../platform/web/persist';
import { colors, fonts, spacing } from '../theme';

/** TopBar 用它已有的订阅拼这份快照；面板只读它，不反过来读全局状态。 */
export interface FeedbackDiag {
  files: number;
  funcs: number;
  edges: number;
  unresolved: number;
  warnings: number;
}

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  diag: FeedbackDiag;
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
  width: 560,
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

const closeBtnStyle: CSSProperties = {
  background: colors.raised,
  color: colors.dim,
  border: '1px solid ' + colors.border,
  borderRadius: 6,
  padding: '2px 10px',
  fontSize: 15,
  lineHeight: '20px',
  cursor: 'pointer',
};

/** 正文自己滚：窗口再矮，也不会把两枚入口和诊断块挤出可视区。 */
const bodyStyle: CSSProperties = {
  overflowY: 'auto',
  padding: '0 ' + spacing.xl + 'px ' + spacing.lg + 'px',
  flex: 1,
};

const introStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.7,
  color: colors.dim,
  margin: '0 0 ' + spacing.md + 'px',
};

const paraStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.7,
  color: colors.text,
  margin: '0 0 ' + spacing.sm + 'px',
};

const labelStyle: CSSProperties = {
  fontSize: 11.5,
  color: colors.dim,
  margin: spacing.sm + 'px 0 6px',
};

/** user-select: all —— 三击就选中，于是不需要「复制」按钮那条出口能力。 */
const addressStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: colors.text,
  background: colors.raised,
  border: '1px solid ' + colors.border,
  borderRadius: 6,
  padding: '6px 10px',
  width: 'fit-content',
  userSelect: 'all',
};

const linkRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: spacing.sm,
  margin: spacing.md + 'px 0 ' + spacing.xs + 'px',
};

const linkStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textDecoration: 'none',
  width: 'fit-content',
  padding: '6px 12px',
  borderRadius: 16,
  background: colors.accentDim,
  color: colors.onAccent,
  border: '1px solid ' + colors.accent,
};

const diagAreaStyle: CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 11,
  lineHeight: 1.6,
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  resize: 'vertical',
  background: colors.bg,
  color: colors.dim,
  border: '1px solid ' + colors.border,
};

const hintStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.7,
  color: colors.dim,
  margin: spacing.sm + 'px 0 0',
};

function readUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

export function FeedbackDialog(props: FeedbackDialogProps): ReactNode {
  const { open, onClose, diag } = props;
  const [persisted, setPersisted] = useState<boolean | null>(null);
  // draft === null 表示「用户还没动过诊断块」，此时文本跟着自动值走（persisted 是异步回来的）
  const [draft, setDraft] = useState<string | null>(null);
  // open 从 false 翻到 true 的**那一帧**就在 render 期清状态（React 官方的
  // adjusting-state-while-rendering 写法）。放进 useEffect 做不到这件事：effect 在
  // commit 之后才跑，浏览器会先绘制一帧上一次的草稿。Event_Logger 那边是 headless
  // Chrome 在 CI 上实测抓住的残影，本机快反而看不见 —— 别把它「优化」回 effect 里。
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(null);
      setPersisted(null);
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 每次打开重新采一次「是否存过会话」；异步，所以只在这里跑
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    hasSession()
      .then((value) => {
        if (alive) setPersisted(value);
      })
      .catch(() => {
        // hasSession 内部已兜底；这层只是不给面板留一个未处理的 rejection
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 依赖必须是**原始值**，不能是 diag 对象：TopBar 在解析过程中会高频重渲，
  // 对象每次都是新的，那样每帧都要重算一遍诊断文本
  const autoText = useMemo(
    () =>
      buildDiagnosticsText({
        build: entryBuildStamp(),
        userAgent: readUserAgent(),
        files: diag.files,
        funcs: diag.funcs,
        edges: diag.edges,
        unresolved: diag.unresolved,
        warnings: diag.warnings,
        persisted,
      }),
    [diag.files, diag.funcs, diag.edges, diag.unresolved, diag.warnings, persisted]
  );

  if (!open) return null;

  const diagText = draft === null ? autoText : draft;
  const issuesHref = issuesHrefFor(diagText);
  const mailHref = mailHrefFor(diagText);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Feedback"
        data-testid="feedback-dialog"
      >
        <div style={headStyle}>
          <div style={titleStyle}>Feedback</div>
          <button
            type="button"
            style={closeBtnStyle}
            onClick={onClose}
            aria-label="Close"
            title="Close"
            data-testid="feedback-close"
          >
            {'✕'}
          </button>
        </div>

        <div style={bodyStyle}>
          <div style={introStyle} data-testid="feedback-intro">
            This page cannot send anything by itself. The only outward action is a link you click
            below - nothing leaves the browser until you do.
          </div>

          <div data-testid="feedback-lines">
            <p style={paraStyle}>
              <strong>GitHub Issues</strong> is the preferred channel: it is public, it can be
              discussed, and you can follow the fix from your report.
            </p>
            {mailHref === null ? null : (
              <p style={paraStyle}>
                <strong>Email</strong> is the private channel. Replies arrive from a personal
                mailbox, not from this address - the forwarding rule lives outside this project.
              </p>
            )}
            <p style={paraStyle}>
              The diagnostics block is counts only - no file names, no function names, no code.
              Change it or delete it freely: each link carries exactly what is in the box when you
              click it.
            </p>
          </div>

          {mailHref === null ? null : (
            <>
              <div style={labelStyle} data-testid="feedback-email-label">
                Private address (triple-click to select)
              </div>
              <div style={addressStyle} title={CONTACT_EMAIL ?? ''} data-testid="feedback-email">
                {CONTACT_EMAIL}
              </div>
            </>
          )}

          <div style={linkRowStyle}>
            {mailHref === null ? null : (
              // 邮件不给 target / rel：交给操作系统的邮件处理器
              <a style={linkStyle} href={mailHref} data-testid="feedback-mail-link">
                Write an email
              </a>
            )}
            <a
              style={linkStyle}
              href={issuesHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="feedback-issues-link"
            >
              Open GitHub Issues
            </a>
          </div>

          <div style={labelStyle} data-testid="feedback-diag-label">
            Diagnostics (editable)
          </div>
          <textarea
            style={diagAreaStyle}
            rows={7}
            spellCheck={false}
            aria-label="Diagnostics"
            value={diagText}
            onChange={(event) => setDraft(event.target.value)}
            data-testid="feedback-diag"
          />

          {mailHref === null ? null : (
            <div style={hintStyle} data-testid="feedback-hint">
              No email client on this device? The address above is a plain text you can paste into
              any webmail, and the diagnostics box can be selected the same way.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FeedbackDialog;
