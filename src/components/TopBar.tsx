/**
 * 顶部工具栏。
 *
 * 承载全局操作与全局信息：上传入口、已上传文件 chips（可单独移除）、
 * 图范围切换（邻域 / 本文件 / 全部）、"显示外部调用"开关、解析统计、
 * 解析进度、致命错误红条与单文件告警黄条。
 *
 * 这里只读 store + 调 store action，不含任何布局/解析逻辑。
 */
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScrollView as RNScrollView, ViewStyle } from 'react-native';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ALL_SCOPE, DEFAULT_DEPTH, fileScope, neighborhoodScope } from '../graph/scope';
import type { Scope } from '../graph/scope';
import { pickFiles } from '../platform/web/filePick';
import type { GraphStats } from '../parser/types';
import { useAppStore, MAX_FILES } from '../state/store';
import { FeedbackDialog } from './FeedbackDialog';
import { colors, fileColor, fonts, spacing, THEMES, THEME_ORDER } from '../theme';
import { useThemeStore } from '../state/themeStore';

/** RN 样式类型里没有横向滚动开关，RNW 支持，用 cast 绕过。 */
const SCROLL_X = { overflowX: 'auto', overflowY: 'visible' } as unknown as ViewStyle;

/**
 * 顶栏必须取消自己这层「层叠上下文」，否则反馈面板的全屏遮罩会被正文面板盖住。
 *
 * 原因在 RNW 里：View 的基础样式写死了 position:'relative' + zIndex:0
 * （node_modules/react-native-web/dist/exports/View/index.js 的 baseStyle），
 * 于是**每一个** View 都是一个层叠上下文。遮罩写成 position:fixed + zIndex:1000
 * 也没用 —— 它只在顶栏这一层内部比较大小，整体仍然排在正文两个面板之后。
 * 实测（冒烟 G6 第一次就是红的）：面板确实在 DOM 里、getBoundingClientRect 坐标
 * 正确，但 elementFromPoint 在那个点上返回的是 svg#graph-svg，截图里看不见面板，
 * 点关闭也点到图上。
 *
 * 只改 zIndex，不改 position：chipTooltip 的绝对定位锚点保持不动；绘制先后也不变
 * （z-index:0 与 auto 在同一个绘制步骤里，仍按 DOM 顺序），被放开的只有顶栏子树里
 * 带 z-index 的那几个覆盖层（chipTooltip 与反馈遮罩）—— 它们本来就该浮在全页之上。
 * RN 的类型里 zIndex 只承认 number，'auto' 是合法 CSS 值，按 SCROLL_X 的先例 cast。
 */
const Z_INDEX_AUTO = 'auto' as unknown as number;

/** 文件 chips 的着色下标：与 GraphPane 用同一份 files 顺序，保证颜色一致。 */
export function colorIndexOfFile(
  graphFiles: string[] | null,
  files: { path: string }[],
  path: string
): number {
  const order = graphFiles ?? files.map((f) => f.path);
  const i = order.indexOf(path);
  return i < 0 ? 0 : i;
}

interface ScopeButtonProps {
  testID: string;
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ScopeButton(props: ScopeButtonProps): ReactNode {
  return (
    <Pressable
      testID={props.testID}
      disabled={props.disabled}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: props.active, disabled: props.disabled }}
      style={[
        styles.segBtn,
        props.active && styles.segBtnActive,
        props.disabled && styles.segBtnDisabled,
      ]}
    >
      <Text style={[styles.segText, props.active && styles.segTextActive]}>{props.label}</Text>
    </Pressable>
  );
}

export function TopBar(): ReactNode {
  const files = useAppStore((s) => s.files);
  const graph = useAppStore((s) => s.graph);
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const warnings = useAppStore((s) => s.warnings);
  const progress = useAppStore((s) => s.progress);
  const activeFile = useAppStore((s) => s.activeFile);
  const selection = useAppStore((s) => s.selection);
  const scope = useAppStore((s) => s.scope);
  const addFiles = useAppStore((s) => s.addFiles);
  const removeFile = useAppStore((s) => s.removeFile);
  const setCtxMenu = useAppStore((s) => s.setCtxMenu);
  const ctxMenu = useAppStore((s) => s.ctxMenu);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const setScope = useAppStore((s) => s.setScope);
  const reset = useAppStore((s) => s.reset);
  const navBack = useAppStore((s) => s.navBack);
  const navForward = useAppStore((s) => s.navForward);
  const navIndex = useAppStore((s) => s.navIndex);
  const navHistory = useAppStore((s) => s.navHistory);
  const [showFeedback, setShowFeedback] = useState(false);
  const [hoveredChip, setHoveredChip] = useState<string | null>(null);
  const [chipScroll, setChipScroll] = useState({ canLeft: false, canRight: false });
  const chipsRef = useRef<RNScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const SCROLL_STEP = 200;
  useEffect(() => {
    if (!ctxMenu) return;
    const h = () => setCtxMenu(null);
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [ctxMenu]);

  const busy = status === 'loading-wasm' || status === 'parsing';
  const canGoBack = navIndex > 0;
  const canGoForward = navIndex >= 0 && navIndex < navHistory.length - 1;
  const selectedId = selection.funcId;
  const depth = scope.kind === 'neighborhood' ? scope.depth : DEFAULT_DEPTH;

  const onPick = (): void => {
    void pickFiles().then((picked) => {
      if (picked.length > 0) void addFiles(picked);
    });
  };

  const onNeighborhood = (): void => {
    if (selectedId) setScope(neighborhoodScope(selectedId, depth));
  };
  const onFileScope = (): void => {
    if (activeFile) setScope(fileScope(activeFile));
  };

  const onChipScroll = (e: {
    nativeEvent: {
      contentOffset: { x: number };
      contentSize: { width: number };
      layoutMeasurement: { width: number };
    };
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollOffsetRef.current = contentOffset.x;
    const canRight = contentOffset.x + layoutMeasurement.width < contentSize.width - 4;
    const canLeft = contentOffset.x > 2;
    setChipScroll({ canLeft, canRight });
  };

  const onChipLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    setChipLayoutWidth(e.nativeEvent.layout.width);
  };

  const onChipContentSize = (w: number, _h?: number) => {
    setChipContentWidth(w);
  };

  const [chipLayoutWidth, setChipLayoutWidth] = useState(0);
  const [chipContentWidth, setChipContentWidth] = useState(0);

  useLayoutEffect(() => {
    // DOM fallback: directly check scrollWidth vs clientWidth
    const el = document.querySelector('[data-testid="topbar-chips"]') as HTMLElement | null;
    let hasOverflow: boolean;
    if (el) {
      hasOverflow = el.scrollWidth > el.clientWidth + 4;
    } else {
      hasOverflow = chipContentWidth > chipLayoutWidth + 4;
    }
    setChipScroll((prev) => {
      if (prev.canRight === hasOverflow && !prev.canLeft) return prev;
      return { canLeft: false, canRight: hasOverflow };
    });
  }, [chipLayoutWidth, chipContentWidth, files]);

  const scrollChips = (dir: 'left' | 'right') => {
    const sv = chipsRef.current;
    if (!sv) return;
    // Use DOM for accurate current position
    const el = document.querySelector('[data-testid="topbar-chips"]') as HTMLElement | null;
    const current = el ? el.scrollLeft : scrollOffsetRef.current;
    if (dir === 'right') {
      const maxScroll = el
        ? Math.max(0, el.scrollWidth - el.clientWidth)
        : Math.max(0, chipContentWidth - chipLayoutWidth);
      const target = Math.min(current + SCROLL_STEP, maxScroll);
      sv.scrollTo({ x: target, animated: true });
    } else {
      const target = Math.max(current - SCROLL_STEP, 0);
      sv.scrollTo({ x: target, animated: true });
    }
  };

  return (
    <View style={styles.wrap} testID="topbar">
      <View style={styles.row}>
        <View style={styles.brand}>
          <Text style={styles.title} numberOfLines={1}>
            Python Code Map
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Upload .py files, parse in-browser, bidirectional code & graph navigation
          </Text>
        </View>

        <View style={styles.actions}>
          <View style={styles.navGroup}>
            <Pressable
              testID="topbar-nav-back"
              onPress={navBack}
              disabled={!canGoBack || busy}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={[styles.navBtn, (!canGoBack || busy) && styles.navBtnDisabled]}
            >
              <Text style={[styles.navBtnText, (!canGoBack || busy) && styles.navBtnTextDisabled]}>
                {'←'}
              </Text>
            </Pressable>
            <Pressable
              testID="topbar-nav-forward"
              onPress={navForward}
              disabled={!canGoForward || busy}
              accessibilityRole="button"
              accessibilityLabel="Forward"
              style={[styles.navBtn, (!canGoForward || busy) && styles.navBtnDisabled]}
            >
              <Text
                style={[styles.navBtnText, (!canGoForward || busy) && styles.navBtnTextDisabled]}
              >
                {'→'}
              </Text>
            </Pressable>
          </View>

          <Pressable
            testID="topbar-upload"
            onPress={onPick}
            disabled={busy}
            accessibilityRole="button"
            style={[styles.btnPrimary, busy && styles.btnDisabled]}
          >
            <Text style={styles.btnPrimaryText}>{busy ? 'Parsing…' : 'Select .py Files'}</Text>
          </Pressable>

          <View style={styles.segment} testID="topbar-scope">
            <ScopeButton
              testID="scope-neighborhood"
              label="Neighborhood"
              active={scope.kind === 'neighborhood'}
              disabled={!selectedId}
              onPress={onNeighborhood}
            />
            <ScopeButton
              testID="scope-file"
              label="This File"
              active={scope.kind === 'file'}
              disabled={!activeFile}
              onPress={onFileScope}
            />
            <ScopeButton
              testID="scope-all"
              label="All"
              active={scope.kind === 'all'}
              disabled={false}
              onPress={() => setScope(ALL_SCOPE)}
            />
          </View>

          {/*
            有意**不**读 busy、不 disabled：这是一个只读入口，解析中、从 IndexedDB 恢复出旧会话时
            都必须能点。盯着那份恢复出来的旧版本看的人，正是最需要报 bug 的人。
            下一次重构请别顺手把它「修好」成 disabled={busy} —— 那样最该用的时候它就没了。
          */}
          {/* Theme 选择器：见下方 ThemeMenu，同样故意不受 busy 门控 */}
          <ThemeMenu />

          <Pressable
            testID="topbar-feedback"
            onPress={() => setShowFeedback(true)}
            accessibilityRole="button"
            accessibilityLabel="Feedback"
            style={styles.btnGhost}
          >
            <Text style={styles.btnGhostText}>Feedback</Text>
          </Pressable>

          {files.length > 0 ? (
            <Pressable
              testID="topbar-reset"
              onPress={() => reset()}
              accessibilityRole="button"
              style={styles.btnGhost}
            >
              <Text style={styles.btnGhostText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {files.length > 0 ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', height: 32, overflow: 'hidden' }}
        >
          <ScrollView
            horizontal
            style={[SCROLL_X, { flex: 1 }]}
            contentContainerStyle={styles.chips}
            showsHorizontalScrollIndicator={false}
            testID="topbar-chips"

            onScroll={onChipScroll}
            onLayout={onChipLayout}
            onContentSizeChange={onChipContentSize}
            scrollEventThrottle={16}
            ref={chipsRef}
          >
            {files.map((f) => {
              const ci = colorIndexOfFile(graph?.files ?? null, files, f.path);
              const active = f.path === activeFile;
              return Platform.OS === 'web' ? (
                <div
                  key={f.path}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({ x: e.clientX, y: e.clientY, path: f.path });
                  }}
                  onMouseEnter={() => setHoveredChip(f.path)}
                  onMouseLeave={() => setHoveredChip(null)}
                  style={{ display: 'inline-block' }}
                >
                  <Pressable
                    testID={'chip-' + f.path}
                    onPress={() => setActiveFile(f.path)}
                    style={[
                      styles.chip,
                      active && styles.chipActive,
                      !!f.error && styles.chipError,
                    ]}
                  >
                    <View style={[styles.chipDot, { backgroundColor: fileColor(ci) }]} />
                    <Text
                      style={[styles.chipText, !!f.error && styles.chipTextError]}
                      numberOfLines={1}
                    >
                      {f.name}
                    </Text>
                    <Pressable
                      testID={'chip-remove-' + f.path}
                      onPress={() => void removeFile(f.path)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel={'Remove ' + f.name}
                      hitSlop={6}
                      style={styles.chipRemove}
                    >
                      <Text style={styles.chipRemoveText}>{'\u00d7'}</Text>
                    </Pressable>
                  </Pressable>
                </div>
              ) : (
                <Pressable
                  key={f.path}
                  testID={'chip-' + f.path}
                  onPress={() => setActiveFile(f.path)}
                  style={[styles.chip, active && styles.chipActive, !!f.error && styles.chipError]}
                >
                  <View style={[styles.chipDot, { backgroundColor: fileColor(ci) }]} />
                  <Text
                    style={[styles.chipText, !!f.error && styles.chipTextError]}
                    numberOfLines={1}
                  >
                    {f.name}
                  </Text>
                  <Pressable
                    testID={'chip-remove-' + f.path}
                    onPress={() => void removeFile(f.path)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={'Remove ' + f.name}
                    hitSlop={6}
                    style={styles.chipRemove}
                  >
                    <Text style={styles.chipRemoveText}>{'\u00d7'}</Text>
                  </Pressable>
                </Pressable>
              );
            })}
          </ScrollView>
          {chipScroll.canLeft ? (
            <Pressable
              testID="chip-scroll-left"
              onPress={() => scrollChips('left')}
              accessibilityRole="button"
              accessibilityLabel="Scroll files left"
              style={styles.chipScrollBtnInline}
            >
              <Text style={styles.chipScrollBtnText}>{'◀'}</Text>
            </Pressable>
          ) : null}
          {chipScroll.canRight ? (
            <Pressable
              testID="chip-scroll-right"
              onPress={() => scrollChips('right')}
              accessibilityRole="button"
              accessibilityLabel="Scroll files right"
              style={styles.chipScrollBtnInline}
            >
              <Text style={styles.chipScrollBtnText}>{'▶'}</Text>
            </Pressable>
          ) : null}
          {hoveredChip ? (
            <View style={styles.chipTooltip} testID={'chip-tooltip-' + hoveredChip}>
              <Text style={styles.chipTooltipText}>
                {files.find((f) => f.path === hoveredChip)?.path}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {busy ? (
        <View style={styles.progressRow} testID="topbar-progress">
          <Text style={styles.progressText}>
            {status === 'loading-wasm'
              ? 'Loading parser…'
              : 'Parsed ' + progress.done + '/' + progress.total}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBar} testID="topbar-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FeedbackDialog
        open={showFeedback}
        onClose={() => setShowFeedback(false)}
        diag={{
          files: files.length,
          funcs: graph?.stats.funcs ?? 0,
          edges: graph?.stats.edges ?? 0,
          unresolved: graph?.stats.unresolved ?? 0,
          warnings: warnings.length,
        }}
      />

      {warnings.length > 0 ? (
        <View style={styles.warnBar} testID="topbar-warnings">
          <Text style={styles.warnText} numberOfLines={3}>
            {warnings.length +
              ' file(s) had issues (skipped or best-effort parsed), remaining files rendered normally:\n' +
              warnings.join('\n')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 主题选择器：顶栏 Theme 按钮 + 下拉面板。
 *
 * 切换本身不重渲染界面 —— 颜色是 <html> 上的 CSS 变量（见 src/platform/web/themeVars.ts），
 * 这里只多一个 store 订阅，为的是在当前主题那一行画勾。
 *
 * 面板的预览色块用的是各主题的**字面 hex**（THEMES[id].colors）：变量只描述「当前」主题，
 * 用它画不出别的主题长什么样。
 *
 * 故意不读 busy、不 disabled：和 Feedback 入口同一个理由 —— 解析中、从 IndexedDB 恢复旧会话时
 * 正是盯着界面看的时候，那时最该能换配色。
 */
function ThemeMenu(): ReactNode {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);

  // 点面板外部关闭：沿用本文件 chip 右键菜单的 window click 写法，只多了一个包含判断 ——
  // ctxMenu 由 contextmenu 事件打开，与 click 不同源，所以它不需要；这个面板恰恰是被
  // 「点 Theme」这枚 click 打开的：React 把 effect 排在被动阶段，同一枚 click 继续冒泡到
  // window 时监听器可能已经装好，不加判断就会「点开又立刻关上」。（FileTabs 的下拉菜单
  // 用的是同一个包含判断；这里按 data-testid 认，不再多要一个 ref —— RN 的 View 类型
  // 上没有 DOM 的 contains，写成 ref 就得为它做一次类型欺骗。）
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        typeof t.closest === 'function' &&
        t.closest('[data-testid="topbar-theme"],[data-testid="theme-panel"]')
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [open]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <View style={styles.themeWrap}>
      <Pressable
        testID="topbar-theme"
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel="Theme"
        style={styles.btnGhost}
      >
        <Text style={styles.btnGhostText}>Theme</Text>
      </Pressable>

      {open ? (
        <View style={styles.themePanel} testID="theme-panel">
          {THEME_ORDER.map((id) => {
            const palette = THEMES[id];
            const current = id === themeId;
            return (
              <Pressable
                key={id}
                testID={'theme-option-' + id}
                onPress={() => {
                  setTheme(id);
                  setOpen(false);
                }}
                accessibilityRole="button"
                // RNW 0.21 把 accessibilityState 当未知 prop 丢掉了（createDOMProps 里没有这一项），
                // 所以当前项还得写进可访问名：读屏用户听到 "Nord (current)"，而不是只看见一个勾。
                accessibilityLabel={current ? palette.label + ' (current)' : palette.label}
                accessibilityState={{ selected: current }}
                style={styles.themeRow}
              >
                <View style={styles.themeSwatches}>
                  {[palette.colors.bg, palette.colors.accent, palette.colors.selected].map(
                    (hex) => (
                      <View key={hex} style={[styles.themeSwatch, { backgroundColor: hex }]} />
                    )
                  )}
                </View>
                <Text style={[styles.themeRowText, current && styles.themeRowTextActive]}>
                  {palette.label}
                </Text>
                {current ? <Text style={styles.themeCheck}>{'✓'}</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // 见 Z_INDEX_AUTO 的注释：不写这行，顶栏自己就是个层叠上下文，反馈遮罩会被埋掉
    zIndex: Z_INDEX_AUTO,
    backgroundColor: colors.panel,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  row: {
    // 见 Z_INDEX_AUTO 的注释：这一层不放开的话，主题面板就被关在顶栏第二行的层叠上下文里
    zIndex: Z_INDEX_AUTO,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  brand: { flexShrink: 1, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.ui, fontSize: 15, fontWeight: '700' },
  subtitle: { color: colors.faint, fontFamily: fonts.ui, fontSize: 11 },
  actions: {
    // 同上：Theme 面板的绝对定位锚点链上的每一层都得是 auto
    zIndex: Z_INDEX_AUTO,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: 'auto',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },

  btnPrimary: {
    backgroundColor: colors.accentDim,
    borderRadius: 7,
    paddingHorizontal: spacing.md,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimaryText: { color: colors.onAccent, fontFamily: fonts.ui, fontSize: 12, fontWeight: '600' },
  btnDisabled: { opacity: 0.55 },
  btnGhost: {
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.md,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navGroup: { flexDirection: 'row', gap: spacing.xs, marginRight: spacing.sm },
  navBtn: {
    width: 28,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: colors.panelAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { color: colors.text, fontSize: 16, fontFamily: fonts.ui },
  navBtnTextDisabled: { color: colors.faint },
  btnGhostText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 12 },

  themeWrap: { zIndex: Z_INDEX_AUTO },
  themePanel: {
    position: 'absolute',
    top: 36,
    right: 0,
    zIndex: 1000,
    minWidth: 190,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 6,
    paddingTop: 4,
    paddingBottom: 4,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  themeSwatches: { flexDirection: 'row', gap: 2 },
  themeSwatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  themeRowText: { color: colors.text, fontFamily: fonts.ui, fontSize: 12, flex: 1 },
  themeRowTextActive: { fontWeight: '600' },
  themeCheck: { color: colors.accent, fontFamily: fonts.ui, fontSize: 12 },

  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  segBtn: {
    paddingHorizontal: spacing.md,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segBtnActive: { backgroundColor: colors.accentDim },
  segBtnDisabled: { opacity: 0.4 },
  segText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 12 },
  segTextActive: { color: colors.onAccent, fontWeight: '600' },

  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 2 },
  chipScrollBtnInline: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginHorizontal: 4,
  },
  chipScrollBtnText: { color: colors.text, fontSize: 10, fontFamily: fonts.ui },
  chipTooltip: {
    position: 'absolute',
    top: 34,
    left: 0,
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
    backgroundColor: colors.tooltipBg,
    borderRadius: 4,
    zIndex: 1000,
    maxWidth: 400,
  },
  chipTooltipText: {
    color: colors.tooltipText,
    fontSize: 12,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 24,
    paddingLeft: spacing.sm,
    paddingRight: 2,
    borderRadius: 12,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { borderColor: colors.accent },
  chipError: { borderColor: colors.danger },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: colors.text, fontFamily: fonts.mono, fontSize: 11, maxWidth: 220 },
  chipTextError: { color: colors.danger },
  chipRemove: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  ctxMenu: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 6,
    paddingTop: 4,
    paddingBottom: 4,
    minWidth: 120,
    zIndex: 1000,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  ctxItem: { paddingHorizontal: 12, paddingVertical: 6 },
  ctxText: { color: colors.text, fontFamily: fonts.ui, fontSize: 12 },
  chipRemoveText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 14, lineHeight: 16 },

  statsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  statsText: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  statsReason: { color: colors.faint, fontFamily: fonts.ui, fontSize: 11, flexShrink: 1 },
  statsScope: { color: colors.faint, fontFamily: fonts.ui, fontSize: 11, marginLeft: 'auto' },

  progressRow: { flexDirection: 'row', alignItems: 'center' },
  progressText: { color: colors.neighbor, fontFamily: fonts.ui, fontSize: 11 },

  errorBar: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 7,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  errorText: { color: colors.danger, fontFamily: fonts.mono, fontSize: 11 },
  warnBar: {
    backgroundColor: colors.warnSoft,
    borderWidth: 1,
    borderColor: colors.warn,
    borderRadius: 7,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  warnText: { color: colors.warn, fontFamily: fonts.ui, fontSize: 11 },
});
