/**
 * 代码区：只读、语法高亮、窗口化渲染。
 *
 * 为什么窗口化：行高写死为 ROW_H，所以"滚动到第 n 行"就是 scrollTo((n-1)*ROW_H)，
 * 不需要任何 DOM 测量；同时几千行的文件也只渲染可视区间 +/- buffer。
 *
 * 三类点击：
 * - 函数名 token（def 行）   -> 选中该函数
 * - 已解析调用点的名字 token -> 选中 callee
 * - 函数体内任意其它位置     -> 选中最内层包含函数
 * 前两类是嵌套的可点击 Text：web 上内层 PressResponder 会 stopPropagation，不会重复触发整行点击。
 */
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  TextStyle,
  ViewStyle,
} from 'react-native';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { buildLineOwners } from '../../parser/symbols';
import type {
  CallSite,
  FuncId,
  FuncSymbol,
  LineTokens,
  TokenScope,
  TokenSpan,
} from '../../parser/types';
import { useActiveFileLines, useFuncIndex } from '../../state/hooks';
import { useAppStore } from '../../state/store';
import {
  CODE_FONT_SIZE,
  GUTTER_W,
  RENDER_BUFFER_ROWS,
  ROW_H,
  colors,
  fonts,
  spacing,
  tokenColors,
} from '../../theme';
import { buildClickRanges, type ClickKind, type ClickRange } from './clickRanges';

/** 用于测量等宽字符真实宽度的字符数 */
export const MEASURE_CHARS = 100;
/** 字体没测出来之前的兜底字符宽度（jsdom / 首帧） */
export const FALLBACK_CHAR_W = 7.2;
/** 定位高亮闪烁时长（ms） */
export const FLASH_MS = 1200;
/** 闪烁层的起始不透明度（随后 1.2s 内淡出到 0） */
export const FLASH_PEAK_OPACITY = 0.85;


/** 可点击片段（buildPieces 的返回类型） */
export interface ClickPiece {
  text: string;
  color: string;
  funcId: FuncId | null;
  kind: ClickKind | null;
  key: string;
  clickable: boolean;
}

/** 固定定位样式（gutter 在水平滚动时保持不动） */
const STICKY = { position: 'sticky', left: 0 } as unknown as ViewStyle;
/** <Text> 保留空白与换行，模拟 <pre> */
const PRE_TEXT = { whiteSpace: 'pre' } as unknown as TextStyle;
/** 允许水平滚动（代码行很长时） */
const SCROLL_X = { overflowX: 'auto' } as unknown as ViewStyle;


/** 将函数体代码复制到剪贴板，返回是否成功 */
async function copyFuncCode(lines: string[], startLine: number, endLine: number): Promise<boolean> {
  const code = lines.slice(startLine - 1, endLine).join('\n');
  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    return false;
  }
}


export interface TokenPiece {
  color: string;
  funcId: FuncId | null;
  kind: ClickKind | null;
  key: string;
  clickable: boolean;
}

function toSegments(text: string, spans: TokenSpan[] | undefined): TokenSpan[] {
  const out: TokenSpan[] = [];
  if (!text) return out;
  let cursor = 0;
  const sorted = spans ? [...spans].sort((a, b) => a.start - b.start) : [];
  for (const s of sorted) {
    const a = Math.max(cursor, s.start);
    const b = Math.min(text.length, s.end);
    if (a > cursor) out.push({ start: cursor, end: a, scope: 'plain' });
    if (b > a) out.push({ start: a, end: b, scope: s.scope });
    cursor = Math.max(cursor, b);
  }
  if (cursor < text.length) out.push({ start: cursor, end: text.length, scope: 'plain' });
  return out;
}

/** 把一行的着色片段再按可点击区间切开，切出来的片段各自带点击目标。 */
export function buildPieces(
  line: number,
  text: string,
  spans: TokenSpan[] | undefined,
  ranges: ClickRange[] | undefined
): ClickPiece[] {
  const segs = toSegments(text, spans);
  if (segs.length === 0) return [];
  const colorOf = (scope: TokenScope): string => tokenColors[scope] ?? tokenColors.plain;
  if (!ranges || ranges.length === 0) {
    return segs.map((s, i) => ({
      text: text.slice(s.start, s.end),
      color: colorOf(s.scope),
      funcId: null,
      kind: null,
      key: line + ':' + i,
      clickable: false,
    }));
  }
  const cuts = new Set<number>();
  for (const r of ranges) {
    cuts.add(Math.max(0, Math.min(text.length, r.start)));
    cuts.add(Math.max(0, Math.min(text.length, r.end)));
  }
  const cutList = [...cuts].sort((a, b) => a - b);

  const pieces: ClickPiece[] = [];
  let idx = 0;
  for (const seg of segs) {
    let pos = seg.start;
    while (pos < seg.end) {
      let stop = seg.end;
      for (const c of cutList) {
        if (c > pos && c < stop) stop = c;
      }
      const range = ranges.find((r) => pos >= r.start && stop <= r.end && r.start < stop) ?? null;
      pieces.push({
        text: text.slice(pos, stop),
        color: colorOf(seg.scope),
        funcId: range ? range.funcId : null,
        kind: range ? range.kind : null,
        key: line + ':' + idx++,
        clickable: !!range,
      });
      pos = stop;
    }
  }
  return pieces;
}

export interface CodeRowProps {
  line: number;
  text: string;
  spans: TokenSpan[] | undefined;
  ranges: ClickRange[] | undefined;
  defFunc: FuncSymbol | null;
  inSelection: boolean;
  onBodyPress: (line: number) => void;
  onTokenPress: (funcId: FuncId) => void;
}

export const CodeRow = memo(function CodeRow(props: CodeRowProps): ReactNode {
  const { line, text, spans, ranges, defFunc, inSelection, onBodyPress, onTokenPress } = props;
  const pieces = useMemo(() => buildPieces(line, text, spans, ranges), [line, text, spans, ranges]);
  return (
    <Pressable
      testID={'code-line-' + line}
      onPress={() => onBodyPress(line)}
      style={[styles.row, inSelection && styles.rowSelected]}
    >
      <View style={[styles.gutter, STICKY, inSelection && styles.gutterSelected]}>
        <Pressable
          testID={'code-def-mark-' + line}
          disabled={!defFunc}
          onPress={defFunc ? () => onTokenPress(defFunc.id) : undefined}
          style={styles.gutterMarkWrap}
        >
          <Text style={[styles.gutterMark, defFunc ? styles.gutterMarkOn : styles.gutterMarkOff]}>
            {'\u0192'}
          </Text>
        </Pressable>
        <Text style={[styles.gutterNum, defFunc && styles.gutterNumDef]}>{line}</Text>
      </View>
      <Text style={[styles.code, PRE_TEXT]}>
        {pieces.map((p) =>
          p.funcId ? (
            <Text
              key={p.key}
              testID={'code-token-' + p.kind + '-' + line}
              onPress={() => onTokenPress(p.funcId as FuncId)}
              style={[{ color: p.color }, styles.clickable]}
            >
              {p.text}
            </Text>
          ) : (
            <Text key={p.key} style={{ color: p.color }}>
              {p.text}
            </Text>
          )
        )}
      </Text>
    </Pressable>
  );
});

export interface CodeWindow {
  first: number;
  last: number;
}

/** 可视区间 + buffer。行高固定，所以这里是纯算术，不需要测量。 */
export function computeWindow(scrollTop: number, viewportH: number, total: number): CodeWindow {
  if (total <= 0) return { first: 1, last: 0 };
  const first = Math.max(1, Math.floor(scrollTop / ROW_H) - RENDER_BUFFER_ROWS);
  const last = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + RENDER_BUFFER_ROWS);
  return { first, last: Math.max(first, last) };
}

export function CodeView(): ReactNode {
  const { path, lines, tokens } = useActiveFileLines();
  const analyses = useAppStore((s) => s.analyses);
  const selection = useAppStore((s) => s.selection);
  const selectFromCode = useAppStore((s) => s.selectFromCode);
  const allFuncs = useFuncIndex();

  const [viewport, setViewport] = useState({ w: 800, h: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const [charW, setCharW] = useState(FALLBACK_CHAR_W);
  const [flash, setFlash] = useState<{ start: number; end: number } | null>(null);
  const [copyToast, setCopyToast] = useState(false);
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const flashRun = useRef<Animated.CompositeAnimation | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const handledNonce = useRef(-1);

  const total = lines.length;

  const fileFuncs = useMemo(() => {
    const out: FuncSymbol[] = [];
    for (const f of allFuncs.values()) if (f.file === path && !f.synthetic) out.push(f);
    out.sort((a, b) => a.startLine - b.startLine);
    return out;
  }, [allFuncs, path]);

  const lineOwners = useMemo(() => buildLineOwners(fileFuncs), [fileFuncs]);

  const defByLine = useMemo(() => {
    const m = new Map<number, FuncSymbol>();
    for (const f of fileFuncs) m.set(f.nameRange.startLine, f);
    return m;
  }, [fileFuncs]);

  const calls = useMemo((): CallSite[] => {
    if (!path) return [];
    const a = analyses.find((x) => x.file.path === path);
    return a ? a.calls : [];
  }, [analyses, path]);

  const clickRanges = useMemo(
    () => buildClickRanges(fileFuncs, calls, lines),
    [fileFuncs, calls, lines]
  );

  const tokensByLine = useMemo(() => {
    const m = new Map<number, LineTokens>();
    for (const t of tokens) m.set(t.line, t);
    return m;
  }, [tokens]);

  const selectedFunc = selection.funcId ? (allFuncs.get(selection.funcId) ?? null) : null;
  /** 选中函数就在当前文件里；合成的 <module> 伪函数不画高亮带（否则整个文件被刷黄） */
  const target = selectedFunc && selectedFunc.file === path ? selectedFunc : null;
  const showBand = !!target && !target.synthetic;

  const maxLen = useMemo(() => {
    let m = 60;
    for (const l of lines) if (l.length > m) m = l.length;
    return Math.min(m, 600);
  }, [lines]);

  const contentWidth = Math.max(viewport.w, Math.round(GUTTER_W + maxLen * charW + spacing.xl * 2));
  const win = computeWindow(scrollTop, viewport.h, total);

  const onContainerLayout = (e: LayoutChangeEvent): void => {
    const { width, height } = e.nativeEvent.layout;
    setViewport((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height }
    );
  };

  const onScrollChange = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const y = e.nativeEvent.contentOffset.y;
    setScrollTop((prev) => (Math.abs(prev - y) < 1 ? prev : y));
  };

  const onMeasure = (e: LayoutChangeEvent): void => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setCharW(w / MEASURE_CHARS);
  };

  const clearFlashTimer = (): void => {
    if (flashTimer.current !== null) {
      clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
  };

  /**
   * 定位闪烁：淡出动画只管观感，卸载交给定时器。
   *
   * 不用动画结束回调来卸载，是因为那个回调在不同环境下时机完全不可控：jsdom 里会
   * 同步触发（闪烁层还没来得及渲染就被摘掉），后台标签页里 rAF 被节流又会迟迟不触发。
   * 动画淡到 opacity 0 之后元素即使还挂着也不可见，定时器到点再摘。
   */
  const runFlash = (start: number, end: number): void => {
    flashRun.current?.stop();
    clearFlashTimer();
    setFlash({ start, end });
    flashOpacity.setValue(FLASH_PEAK_OPACITY);
    const anim = Animated.timing(flashOpacity, {
      toValue: 0,
      duration: FLASH_MS,
      useNativeDriver: false,
    });
    flashRun.current = anim;
    anim.start(() => {
      flashRun.current = null;
    });
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlash(null);
    }, FLASH_MS);
  };

  // 切文件回到顶部。必须声明在下面那个 selection 效果之前：跨文件的图 -> 代码定位
  // 会在同一次 commit 里同时改 activeFile 与 selection，React 按声明顺序执行 effect，
  // 先复位、再定位，滚动位置和闪烁才不会被复位抹掉。
  useEffect(() => {
    clearFlashTimer();
    setScrollTop(0);
    setFlash(null);
  }, [path]);

  // 图 -> 代码 或 后退/前进：滚动到 def 行 + 闪烁
  // code -> code（点击代码区）不触发，避免用户刚点完就被滚走
  useEffect(() => {
    if (!target || !path) return;
    if (selection.source === 'code') return;
    if (selection.nonce === handledNonce.current) return;
    handledNonce.current = selection.nonce;
    const y = Math.max(0, (target.defLine - 1) * ROW_H - Math.round(viewport.h / 3));
    scrollRef.current?.scrollTo({ y, animated: true });
    setScrollTop(y);
    if (!target.synthetic) runFlash(target.startLine, target.endLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.nonce, target, path, viewport.h]);

  useEffect(() => {
    return () => {
      flashRun.current?.stop();
      clearFlashTimer();
    };
  }, []);

  const onBodyPress = (line: number): void => {
    const owner = lineOwners.get(line);
    selectFromCode(owner ? owner.id : null);
    // 复制函数体代码到剪贴板
    if (owner) {
      copyFuncCode(lines, owner.startLine, owner.endLine).then((ok) => {
        if (ok) {
          setCopyToast(true);
          setTimeout(() => setCopyToast(false), 1500);
        }
      });
    }
  };

  const onTokenPress = (funcId: FuncId): void => {
    selectFromCode(funcId);
    // 复制函数体代码到剪贴板
    const func = allFuncs.get(funcId);
    if (func) {
      copyFuncCode(lines, func.startLine, func.endLine).then((ok) => {
        if (ok) {
          setCopyToast(true);
          setTimeout(() => setCopyToast(false), 1500);
        }
      });
    }
  };

  const rows: ReactNode[] = [];
  for (let line = win.first; line <= win.last; line++) {
    const defFunc = defByLine.get(line) ?? null;
    rows.push(
      <CodeRow
        key={line}
        line={line}
        text={lines[line - 1] ?? ''}
        spans={tokensByLine.get(line)?.spans}
        ranges={clickRanges.get(line)}
        defFunc={defFunc}
        inSelection={showBand && !!target && line >= target.startLine && line <= target.endLine}
        onBodyPress={onBodyPress}
        onTokenPress={onTokenPress}
      />
    );
  }

  if (!path) {
    return (
      <View style={styles.container} testID="code-empty">
        <Text style={styles.emptyText}>
          {'\u5148\u5728\u4e0a\u65b9\u9009\u62e9 .py \u6587\u4ef6'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={onContainerLayout} testID="code-view">
      <ScrollView
        ref={scrollRef}
        style={[styles.scroll, SCROLL_X]}
        contentContainerStyle={{ width: contentWidth }}
        onScroll={onScrollChange}
        scrollEventThrottle={32}
        testID="code-scroll"
      >
        <View style={{ height: Math.max(total * ROW_H, 1) }}>
          <View
            style={{
              position: 'absolute',
              top: (win.first - 1) * ROW_H,
              left: 0,
              width: contentWidth,
            }}
          >
            {rows}
          </View>
          {showBand && target ? (
            <View
              testID="code-selection-band"
              style={{
                pointerEvents: 'none',
                position: 'absolute',
                top: (target.startLine - 1) * ROW_H,
                left: 0,
                width: contentWidth,
                height: (target.endLine - target.startLine + 1) * ROW_H,
                borderLeftWidth: 2,
                borderLeftColor: colors.selected,
              }}
            />
          ) : null}
          {flash ? (
            <Animated.View
              testID="code-flash"
              style={{
                pointerEvents: 'none',
                position: 'absolute',
                top: (flash.start - 1) * ROW_H,
                left: 0,
                width: contentWidth,
                height: (flash.end - flash.start + 1) * ROW_H,
                backgroundColor: colors.selected,
                opacity: flashOpacity,
              }}
            />
          ) : null}
        </View>

          {copyToast ? (
            <View
              style={{
                position: 'absolute',
                bottom: 16,
                left: '50%',
                transform: [{ translateX: -60 }],
                backgroundColor: colors.ok,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                zIndex: 100,
              }}
              testID="copy-toast"
            >
              <Text style={{ color: colors.bg, fontSize: 12, fontFamily: fonts.ui }}>Copied</Text>
            </View>
          ) : null}
      </ScrollView>
      <View style={styles.measurerWrap} onLayout={onMeasure}>
        <Text style={[styles.measurer, PRE_TEXT]}>{'0'.repeat(MEASURE_CHARS)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.panel, position: 'relative', overflow: 'hidden' },
  scroll: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', height: ROW_H, width: '100%' },
  rowSelected: { backgroundColor: colors.selectedSoft },
  gutter: {
    width: GUTTER_W,
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: spacing.sm,
    backgroundColor: colors.panel,
    userSelect: 'none',
  },
  gutterSelected: { backgroundColor: colors.panelAlt },
  gutterMarkWrap: { width: 16, alignItems: 'center', justifyContent: 'center' },
  gutterMark: { fontFamily: fonts.mono, fontSize: CODE_FONT_SIZE, lineHeight: ROW_H },
  gutterMarkOn: { color: colors.accent },
  gutterMarkOff: { color: 'transparent' },
  gutterNum: {
    fontFamily: fonts.mono,
    fontSize: CODE_FONT_SIZE,
    lineHeight: ROW_H,
    color: colors.faint,
    minWidth: 30,
    textAlign: 'right',
  },
  gutterNumDef: { color: colors.accent },
  code: {
    fontFamily: fonts.mono,
    fontSize: CODE_FONT_SIZE,
    lineHeight: ROW_H,
    color: colors.text,
    flexShrink: 0,
    userSelect: 'text',
  },
  clickable: { textDecorationLine: 'underline', textDecorationColor: 'rgba(201, 209, 217, 0.4)' },
  emptyText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 13, padding: spacing.lg },
  // pointerEvents 走 style：RN 0.78+ / RNW 0.21 已废弃 prop 形式
  measurerWrap: {
    pointerEvents: 'none',
    position: 'absolute',
    top: -2000,
    left: -2000,
    opacity: 0,
  },
  measurer: { fontFamily: fonts.mono, fontSize: CODE_FONT_SIZE, lineHeight: ROW_H },
});
