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
import { colors, fileColor, fonts, spacing } from '../theme';

/** RN 样式类型里没有横向滚动开关，RNW 支持，用 cast 绕过。 */
const SCROLL_X = { overflowX: 'auto', overflowY: 'visible' } as unknown as ViewStyle;


/** 文件 chips 的着色下标：与 GraphPane 用同一份 files 顺序，保证颜色一致。 */
export function colorIndexOfFile(graphFiles: string[] | null, files: { path: string }[], path: string): number {
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
      style={[styles.segBtn, props.active && styles.segBtnActive, props.disabled && styles.segBtnDisabled]}
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
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const setScope = useAppStore((s) => s.setScope);
  const reset = useAppStore((s) => s.reset);
  const navBack = useAppStore((s) => s.navBack);
  const navForward = useAppStore((s) => s.navForward);
  const navIndex = useAppStore((s) => s.navIndex);
  const navHistory = useAppStore((s) => s.navHistory);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [hoveredChip, setHoveredChip] = useState<string | null>(null);
  const [chipScroll, setChipScroll] = useState({ canLeft: false, canRight: false });
  const chipsRef = useRef<RNScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const SCROLL_STEP = 200;
  useEffect(() => { if (!ctxMenu) return; const h = () => setCtxMenu(null); window.addEventListener('click', h); return () => window.removeEventListener('click', h); }, [ctxMenu]);



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

  const onChipScroll = (e: { nativeEvent: { contentOffset: { x: number }; contentSize: { width: number }; layoutMeasurement: { width: number } } }) => {
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
    setChipScroll(prev => {
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
      const maxScroll = el ? Math.max(0, el.scrollWidth - el.clientWidth) : Math.max(0, chipContentWidth - chipLayoutWidth);
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
            Python Call Graph
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
              <Text style={[styles.navBtnText, (!canGoForward || busy) && styles.navBtnTextDisabled]}>
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
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 32, overflow: 'hidden' }}>
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
            ref={chipsRef}>
            {files.map((f) => {
              const ci = colorIndexOfFile(graph?.files ?? null, files, f.path);
              const active = f.path === activeFile;
              return (
                Platform.OS === 'web' ? (
                  <div
                    key={f.path}
                    onMouseEnter={() => setHoveredChip(f.path)}
                    onMouseLeave={() => setHoveredChip(null)}
                    style={{ display: 'inline-block' }}
                  >
                    <Pressable
                      testID={'chip-' + f.path}
                      onPress={() => setActiveFile(f.path)}
                      style={[styles.chip, active && styles.chipActive, !!f.error && styles.chipError]}>
                      <View style={[styles.chipDot, { backgroundColor: fileColor(ci) }]} />
                      <Text style={[styles.chipText, !!f.error && styles.chipTextError]} numberOfLines={1}>
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
                    style={[styles.chip, active && styles.chipActive, !!f.error && styles.chipError]}>
                    <View style={[styles.chipDot, { backgroundColor: fileColor(ci) }]} />
                    <Text style={[styles.chipText, !!f.error && styles.chipTextError]} numberOfLines={1}>
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
                )
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
              <Text style={styles.chipTooltipText}>{files.find((f) => f.path === hoveredChip)?.path}</Text>
            </View>
          ) : null}
        </View>
      ) : null}


      {ctxMenu ? (
        <View
          testID="chip-context-menu"
          style={[styles.ctxMenu, { left: ctxMenu.x, top: ctxMenu.y }]}
          onStartShouldSetResponder={() => true}
        >
          <Pressable
            testID="ctx-close"
            onPress={() => { void removeFile(ctxMenu.path); setCtxMenu(null); }}
            style={styles.ctxItem}
          >
            <Text style={styles.ctxText}>Close</Text>
          </Pressable>
          <Pressable
            testID="ctx-close-others"
            onPress={() => {
              const keep = ctxMenu.path;
              const others = files.filter((f) => f.path !== keep);
              Promise.all(others.map((f) => removeFile(f.path))).then(() => setCtxMenu(null));
            }}
            style={styles.ctxItem}
          >
            <Text style={styles.ctxText}>Close Others</Text>
          </Pressable>
          <Pressable
            testID="ctx-close-all"
            onPress={() => { reset(); setCtxMenu(null); }}
            style={styles.ctxItem}
          >
            <Text style={styles.ctxText}>Close All</Text>
          </Pressable>
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

      {warnings.length > 0 ? (
        <View style={styles.warnBar} testID="topbar-warnings">
          <Text style={styles.warnText} numberOfLines={3}>
            {warnings.length + ' file(s) had issues (skipped or best-effort parsed), remaining files rendered normally:\n' + warnings.join('\n')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.panel,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  brand: { flexShrink: 1, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.ui, fontSize: 15, fontWeight: '700' },
  subtitle: { color: colors.faint, fontFamily: fonts.ui, fontSize: 11 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' },

  btnPrimary: {
    backgroundColor: colors.accentDim,
    borderRadius: 7,
    paddingHorizontal: spacing.md,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimaryText: { color: '#ffffff', fontFamily: fonts.ui, fontSize: 12, fontWeight: '600' },
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

  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  segBtn: { paddingHorizontal: spacing.md, height: 26, alignItems: 'center', justifyContent: 'center' },
  segBtnActive: { backgroundColor: colors.accentDim },
  segBtnDisabled: { opacity: 0.4 },
  segText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 12 },
  segTextActive: { color: '#ffffff', fontWeight: '600' },


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
    paddingVertical: 4,
    backgroundColor: '#1e1e1e',
    borderRadius: 4,
    zIndex: 1000,
    maxWidth: 400,
  },
  chipTooltipText: {
    color: '#cccccc',
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
    position: 'absolute',
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 6,
    paddingVertical: 4,
    minWidth: 120,
    zIndex: 1000,
    shadowColor: '#000',
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
    backgroundColor: 'rgba(248, 81, 73, 0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 7,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  errorText: { color: colors.danger, fontFamily: fonts.mono, fontSize: 11 },
  warnBar: {
    backgroundColor: 'rgba(210, 153, 34, 0.1)',
    borderWidth: 1,
    borderColor: colors.warn,
    borderRadius: 7,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  warnText: { color: colors.warn, fontFamily: fonts.ui, fontSize: 11 },
});


