/**
 * 文件标签栏：横向 chips，点击切换 activeFile；解析失败的文件带红点。
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useAppStore } from '../../state/store';
import { colors, fonts, spacing } from '../../theme';

/** RNW 支持、但 RN 样式类型里没有的横向滚动开关。 */
const SCROLL_X = { overflowX: 'auto', overflowY: 'hidden' } as unknown as ViewStyle;

/** 只取文件名（不含目录），标签栏空间有限。 */
export function shortName(p: string): string {
  const parts = (p || '').split('/');
  return parts[parts.length - 1] ?? p;
}

export function FileTabs(): ReactNode {
  const files = useAppStore((s) => s.files);
  const activeFile = useAppStore((s) => s.activeFile);
  const setActiveFile = useAppStore((s) => s.setActiveFile);

  if (files.length === 0) return null;

  return (
    <View style={styles.wrap} testID="file-tabs">
      <ScrollView
        horizontal
        style={SCROLL_X}
        contentContainerStyle={styles.content}
        showsHorizontalScrollIndicator={false}
        testID="file-tabs-scroll"
      >
        {files.map((f) => {
          const active = f.path === activeFile;
          return (
            <Pressable
              key={f.path}
              testID={'file-tab-' + f.path}
              onPress={() => setActiveFile(f.path)}
              style={[styles.tab, active && styles.tabActive, !!f.error && styles.tabError]}
            >
              <Text
                style={[styles.tabText, active && styles.tabTextActive, !!f.error && styles.tabTextError]}
                numberOfLines={1}
              >
                {shortName(f.path)}
              </Text>
              {f.error ? <Text style={styles.errDot}>{'\u25cf'}</Text> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    maxHeight: 38,
  },
  content: { flexDirection: 'row', alignItems: 'center' },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    height: 32,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  tabActive: { backgroundColor: colors.panel, borderBottomWidth: 2, borderBottomColor: colors.accent },
  tabError: { borderBottomWidth: 2, borderBottomColor: colors.danger },
  tabText: { fontFamily: fonts.ui, fontSize: 12, color: colors.dim },
  tabTextActive: { color: colors.text },
  tabTextError: { color: colors.danger },
  errDot: { fontSize: 8, color: colors.danger, marginLeft: 2 },
});
