/**
 * 顶部工具栏。
 *
 * 承载全局操作与全局信息：上传入口、已上传文件 chips（可单独移除）、
 * 图范围切换（邻域 / 本文件 / 全部）、"显示外部调用"开关、解析统计、
 * 解析进度、致命错误红条与单文件告警黄条。
 *
 * 这里只读 store + 调 store action，不含任何布局/解析逻辑。
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { ALL_SCOPE, DEFAULT_DEPTH, fileScope, neighborhoodScope } from '../graph/scope';
import type { Scope } from '../graph/scope';
import { pickFiles } from '../platform/web/filePick';
import type { GraphStats, UnresolvedReason } from '../parser/types';
import { useAppStore } from '../state/store';
import { colors, fileColor, fonts, spacing } from '../theme';

/** RN 样式类型里没有横向滚动开关，RNW 支持，用 cast 绕过。 */
const SCROLL_X = { overflowX: 'auto', overflowY: 'hidden' } as unknown as ViewStyle;

export const REASON_LABELS: Record<UnresolvedReason, string> = {
  ambiguous: '歧义',
  external: '外部',
  dynamic: '动态',
  unknown: '未知',
};

const REASON_ORDER: UnresolvedReason[] = ['ambiguous', 'external', 'dynamic', 'unknown'];

export function scopeLabel(scope: Scope): string {
  if (scope.kind === 'neighborhood') return '邻域';
  if (scope.kind === 'file') return '本文件';
  return '全部';
}

/** 主统计行：函数 / 边 / 未解析 / 耗时。 */
export function formatStats(stats: GraphStats): string {
  return (
    '函数 ' + stats.funcs +
    '  ·  连边 ' + stats.edges +
    '  ·  未解析 ' + stats.unresolved +
    '  ·  耗时 ' + stats.ms + 'ms'
  );
}

/** 未解析调用按 reason 的明细；全 0 时返回 ''。 */
export function formatReasons(stats: GraphStats): string {
  const parts: string[] = [];
  for (const r of REASON_ORDER) {
    const n = stats.byReason[r] ?? 0;
    if (n > 0) parts.push(REASON_LABELS[r] + ' ' + n);
  }
  return parts.join('  ·  ');
}

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
  const showExternal = useAppStore((s) => s.showExternal);
  const addFiles = useAppStore((s) => s.addFiles);
  const removeFile = useAppStore((s) => s.removeFile);
  const setScope = useAppStore((s) => s.setScope);
  const setShowExternal = useAppStore((s) => s.setShowExternal);
  const reset = useAppStore((s) => s.reset);

  const busy = status === 'loading-wasm' || status === 'parsing';
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

  return (
    <View style={styles.wrap} testID="topbar">
      <View style={styles.row}>
        <View style={styles.brand}>
          <Text style={styles.title} numberOfLines={1}>
            Python 调用关系图
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            上传 .py 文件，浏览器内解析，代码与图双向定位
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            testID="topbar-upload"
            onPress={onPick}
            disabled={busy}
            accessibilityRole="button"
            style={[styles.btnPrimary, busy && styles.btnDisabled]}
          >
            <Text style={styles.btnPrimaryText}>{busy ? '解析中…' : '选择 .py 文件'}</Text>
          </Pressable>

          <View style={styles.segment} testID="topbar-scope">
            <ScopeButton
              testID="scope-neighborhood"
              label="邻域"
              active={scope.kind === 'neighborhood'}
              disabled={!selectedId}
              onPress={onNeighborhood}
            />
            <ScopeButton
              testID="scope-file"
              label="本文件"
              active={scope.kind === 'file'}
              disabled={!activeFile}
              onPress={onFileScope}
            />
            <ScopeButton
              testID="scope-all"
              label="全部"
              active={scope.kind === 'all'}
              disabled={false}
              onPress={() => setScope(ALL_SCOPE)}
            />
          </View>

          <Pressable
            testID="toggle-external"
            onPress={() => setShowExternal(!showExternal)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: showExternal }}
            style={[styles.toggle, showExternal && styles.toggleOn]}
          >
            <View style={[styles.toggleDot, showExternal && styles.toggleDotOn]} />
            <Text style={[styles.toggleText, showExternal && styles.toggleTextOn]}>显示外部调用</Text>
          </Pressable>

          {files.length > 0 ? (
            <Pressable
              testID="topbar-reset"
              onPress={() => reset()}
              accessibilityRole="button"
              style={styles.btnGhost}
            >
              <Text style={styles.btnGhostText}>清空</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {files.length > 0 ? (
        <ScrollView
          horizontal
          style={SCROLL_X}
          contentContainerStyle={styles.chips}
          showsHorizontalScrollIndicator={false}
          testID="topbar-chips"
        >
          {files.map((f) => {
            const ci = colorIndexOfFile(graph?.files ?? null, files, f.path);
            const active = f.path === activeFile;
            return (
              <View
                key={f.path}
                testID={'chip-' + f.path}
                style={[styles.chip, active && styles.chipActive, !!f.error && styles.chipError]}
              >
                <View style={[styles.chipDot, { backgroundColor: fileColor(ci) }]} />
                <Text style={[styles.chipText, !!f.error && styles.chipTextError]} numberOfLines={1}>
                  {f.name}
                </Text>
                <Pressable
                  testID={'chip-remove-' + f.path}
                  onPress={() => void removeFile(f.path)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={'移除 ' + f.name}
                  hitSlop={6}
                  style={styles.chipRemove}
                >
                  <Text style={styles.chipRemoveText}>{'\u00d7'}</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      ) : null}

      {graph ? (
        <View style={styles.statsRow} testID="topbar-stats">
          <Text style={styles.statsText}>{formatStats(graph.stats)}</Text>
          {formatReasons(graph.stats) ? (
            <Text style={styles.statsReason} testID="topbar-stats-reasons" numberOfLines={1}>
              {'未解析明细：' + formatReasons(graph.stats)}
            </Text>
          ) : null}
          <Text style={styles.statsScope} numberOfLines={1}>
            {'范围：' + scopeLabel(scope)}
          </Text>
        </View>
      ) : null}

      {busy ? (
        <View style={styles.progressRow} testID="topbar-progress">
          <Text style={styles.progressText}>
            {status === 'loading-wasm'
              ? '正在加载解析引擎…'
              : '已解析 ' + progress.done + '/' + progress.total}
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
            {warnings.length + ' 个文件存在问题（已跳过或尽力解析），其余文件仍正常出图：\n' + warnings.join('\n')}
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
    height: 28,
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
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
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

  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: spacing.sm,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  toggleOn: { borderColor: colors.accent, backgroundColor: 'rgba(88, 166, 255, 0.12)' },
  toggleDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.faint },
  toggleDotOn: { backgroundColor: colors.accent },
  toggleText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 12 },
  toggleTextOn: { color: colors.neighbor },

  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 2 },
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
