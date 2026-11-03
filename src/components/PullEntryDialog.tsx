/**
 * 拉取粘贴对话框（issue #8）：顶栏入口与空态上传面板入口共用的同一个模态。
 *
 * 这一层只做两件事 —— 把原文交给 store 的 pullFromText，以及在拉取进行中禁用确认按钮；
 * 分流、请求推导、限额、报错分类全在 src/pull/ 与 store 里，组件不重复判断任何一条规则。
 *
 * 与 PullListingDialog 一样用原生 div / textarea：模态要接住键盘（Escape）与遮罩点击，
 * RN-web 的 Pressable 不转发这些行为。开/关状态在 store（pullEntryOpen）——
 * 两个入口（TopBar / UploadPanel）都能开，对话框本体在 AppRoot 只挂一份。
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  formatStars,
  pickSampleProject,
  type SampleProject,
} from '../data/sampleProjects';
import { useAppStore } from '../state/store';
import { colors, fonts, spacing } from '../theme';

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
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  fontFamily: fonts.ui,
  color: colors.text,
  padding: spacing.xl,
};

const titleStyle: CSSProperties = { fontSize: 17, fontWeight: 700 };

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: colors.dim,
  marginTop: spacing.sm,
};

const inputStyle: CSSProperties = {
  width: '100%',
  minHeight: 96,
  boxSizing: 'border-box',
  marginTop: spacing.md,
  borderRadius: 8,
  border: '1px solid ' + colors.borderStrong,
  background: colors.bg,
  color: colors.text,
  fontFamily: fonts.mono,
  fontSize: 12,
  padding: spacing.sm,
  resize: 'vertical',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  marginTop: spacing.md,
};

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

const ghostBtnStyle: CSSProperties = {
  background: 'transparent',
  color: colors.dim,
  border: '1px solid ' + colors.borderStrong,
  borderRadius: 6,
  padding: '7px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const disabledBtnStyle: CSSProperties = { opacity: 0.6, cursor: 'default' };

const sampleLabelStyle: CSSProperties = {
  fontSize: 11,
  color: colors.faint,
  letterSpacing: 1,
  textTransform: 'uppercase',
};

const sampleCardStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'left',
  marginTop: spacing.xs,
  background: colors.panelAlt,
  color: colors.text,
  border: '1px solid ' + colors.borderStrong,
  borderRadius: 8,
  padding: spacing.md,
  fontFamily: fonts.ui,
  cursor: 'pointer',
};

const sampleTopRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: spacing.sm,
};

const sampleNameStyle: CSSProperties = { fontSize: 14, fontWeight: 700 };
const sampleStarsStyle: CSSProperties = { fontSize: 11, color: colors.dim, whiteSpace: 'nowrap' };

const sampleMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  marginTop: 2,
};

const sampleChipStyle: CSSProperties = {
  fontSize: 10,
  color: colors.accent,
  border: '1px solid ' + colors.borderStrong,
  borderRadius: 4,
  padding: '1px 6px',
  whiteSpace: 'nowrap',
};

const sampleFullNameStyle: CSSProperties = {
  fontSize: 11,
  color: colors.dim,
  fontFamily: fonts.mono,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// 两行截断：清单里偶有长描述，不能让它把对话框撑高
const sampleDescriptionStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  marginTop: spacing.xs,
  fontSize: 12,
  color: colors.dim,
};

const sampleActionStyle: CSSProperties = {
  display: 'inline-block',
  marginTop: spacing.sm,
  background: colors.accentDim,
  color: colors.onAccent,
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 600,
};

const sampleFootStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  marginTop: spacing.sm,
};

const sampleNoteStyle: CSSProperties = { fontSize: 11, color: colors.faint };

const shuffleBtnStyle: CSSProperties = { ...ghostBtnStyle, padding: '5px 12px', fontSize: 12 };

export interface PullEntryDialogProps {
  /** 随机源；不传则用样本模块的默认值（Math.random），测试注入固定值 */
  random?: () => number;
  /** 候选示例项目；不传则用样本模块的内置清单，测试用它覆盖“空清单”场景 */
  projects?: readonly SampleProject[];
}

export function PullEntryDialog({ random, projects }: PullEntryDialogProps = {}): ReactNode {
  const open = useAppStore((s) => s.pullEntryOpen);
  const setOpen = useAppStore((s) => s.setPullEntryOpen);
  const pullFromText = useAppStore((s) => s.pullFromText);
  const pulling = useAppStore((s) => s.pulling);
  const status = useAppStore((s) => s.status);
  const busy = status === 'loading-wasm' || status === 'parsing';
  const [draft, setDraft] = useState('');
  const [sample, setSample] = useState<SampleProject | null>(null);
  // 提交票据：拉取还在飞的时候对话框可能已被关掉又重开（换过一茬）。重开就作废旧票据，
  // 旧提交的收尾因此不会收掉新对话框、清掉新草稿 —— 它只管自己那一茬。
  const submitSeq = useRef(0);

  // 每次关上（取消 / 提交完成 / Escape）都清掉草稿：再打开时看到的是空框，不是上次剩的
  const close = (): void => {
    setDraft('');
    setOpen(false);
  };

  useEffect(() => {
    if (open) submitSeq.current += 1;
  }, [open]);

  // 每次打开抽一次示例项目；关闭不清（不可见），重开自然重抽
  useEffect(() => {
    if (!open) return;
    setSample(pickSampleProject({ random, projects }));
  }, [open, random, projects]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // close 只依赖 setOpen（zustand action，引用恒定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const onSubmit = (): void => {
    // 空粘贴不触发：连一句提示都不必走一趟 store
    if (draft.trim().length === 0) return;
    const text = draft;
    const ticket = ++submitSeq.current;
    void pullFromText(text).then(() => {
      if (submitSeq.current === ticket) close();
    });
  };

  // 点卡片只改草稿：提交时机仍归用户（不自动 Pull、不关窗）
  const fillDraftFromSample = (): void => {
    if (!sample) return;
    setDraft(sample.urls.join('\n'));
  };

  // Shuffle 只换建议，不动草稿；抽不出别的（例如候选只有一个）就维持当前
  const shuffleSample = (): void => {
    setSample(
      (current) =>
        pickSampleProject({
          random,
          projects,
          excludeFullName: current?.fullName ?? null,
        }) ?? current
    );
  };

  return (
    <div style={overlayStyle} onClick={close}>
      <div
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Pull from URL"
        data-testid="pull-dialog"
      >
        <div style={titleStyle}>Pull from URL</div>
        <div style={hintStyle}>
          {
            'One URL per line: a GitHub repository, directory, or file page, or a direct link to a .py / .pyi file on any host. Each line is pulled as its own batch — batches succeed or fail independently; every request is a GET with an empty body.'
          }
        </div>
        {sample ? (
          <div style={{ marginTop: spacing.md }}>
            <div style={sampleLabelStyle}>Try a sample project</div>
            <button
              type="button"
              style={sampleCardStyle}
              onClick={fillDraftFromSample}
              data-testid="pull-sample"
            >
              <span style={sampleTopRowStyle}>
                <span style={sampleNameStyle}>{sample.name}</span>
                <span style={sampleStarsStyle}>{formatStars(sample.stars)} stars</span>
              </span>
              <span style={sampleMetaStyle}>
                <span style={sampleChipStyle}>{sample.category}</span>
                <span style={sampleFullNameStyle}>{sample.fullName}</span>
              </span>
              {sample.description ? (
                <span style={sampleDescriptionStyle}>{sample.description}</span>
              ) : null}
              <span style={sampleActionStyle}>{`Use these ${sample.urls.length} URLs`}</span>
            </button>
            <div style={sampleFootStyle}>
              <button
                type="button"
                style={shuffleBtnStyle}
                onClick={shuffleSample}
                data-testid="pull-sample-shuffle"
              >
                Shuffle
              </button>
              <span style={sampleNoteStyle}>Shuffle changes the suggestion only</span>
            </div>
          </div>
        ) : null}
        <textarea
          style={inputStyle}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={4}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={'https://example.com/project/module.py'}
          aria-label="URLs to pull"
          data-testid="pull-input"
        />
        <div style={rowStyle}>
          <button
            type="button"
            style={{ ...primaryBtnStyle, ...(pulling || busy ? disabledBtnStyle : {}) }}
            onClick={onSubmit}
            disabled={pulling || busy}
            data-testid="pull-submit"
          >
            {pulling ? 'Pulling…' : 'Pull'}
          </button>
          {/* 取消只是关对话框：进行中的拉取不会被它打断（它本来也不是「取消请求」） */}
          <button type="button" style={ghostBtnStyle} onClick={close} data-testid="pull-cancel">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default PullEntryDialog;
