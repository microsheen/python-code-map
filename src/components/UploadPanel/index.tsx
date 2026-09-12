/**
 * 空态：上传入口（按钮 + 拖拽区）。
 * 拖拽监听统一挂在 AppRoot（这样已有文件时也能继续拖入），这里只负责呈现。
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { pickFiles } from '../../platform/web/filePick';
import { useAppStore } from '../../state/store';
import { colors, fonts, spacing } from '../../theme';

export interface UploadPanelProps {
  dragging?: boolean;
}

export function UploadPanel(props: UploadPanelProps): ReactNode {
  const dragging = !!props.dragging;
  const addFiles = useAppStore((s) => s.addFiles);
  const status = useAppStore((s) => s.status);
  const progress = useAppStore((s) => s.progress);
  const busy = status === 'loading-wasm' || status === 'parsing';

  const onPick = (): void => {
    void pickFiles().then((picked) => {
      if (picked.length > 0) void addFiles(picked);
    });
  };

  return (
    <View style={styles.wrap} testID="upload-panel">
      <View style={[styles.dropzone, dragging && styles.dropzoneActive]} testID="upload-dropzone">
        <Text style={styles.title}>{'Python \u8c03\u7528\u5173\u7cfb\u56fe'}</Text>
        <Text style={styles.subtitle}>
          {'\u4e0a\u4f20\u4e00\u4e2a\u6216\u591a\u4e2a .py / .pyi \u6587\u4ef6\uff0c\u5728\u6d4f\u89c8\u5668\u5185\u89e3\u6790\u51fd\u6570\u8c03\u7528\u5173\u7cfb\u3002'}
        </Text>
        <Text style={styles.hint}>
          {'\u4e5f\u53ef\u4ee5\u76f4\u63a5\u628a\u6587\u4ef6\u62d6\u5230\u9875\u9762\u4efb\u610f\u4f4d\u7f6e\u3002\u4ee3\u7801\u4e0d\u4f1a\u79bb\u5f00\u6d4f\u89c8\u5668\uff0c\u4e5f\u4e0d\u4f1a\u88ab\u4fdd\u5b58\u3002'}
        </Text>
        <Pressable
          testID="upload-pick"
          style={[styles.btn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={onPick}
        >
          <Text style={styles.btnText}>
            {busy ? '\u89e3\u6790\u4e2d ' + progress.done + '/' + progress.total : '\u9009\u62e9 .py \u6587\u4ef6'}
          </Text>
        </Pressable>
        <Text style={styles.footnote}>
          {'\u5355\u6587\u4ef6\u4e0a\u9650 1MB\uff1b\u8de8\u6587\u4ef6\u8c03\u7528\u9700\u8981\u76f8\u5173\u6587\u4ef6\u4e00\u8d77\u4e0a\u4f20\u624d\u80fd\u8fde\u8fb9\u3002'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.bg },
  dropzone: {
    width: '100%',
    maxWidth: 620,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    borderRadius: 14,
    backgroundColor: colors.panel,
    padding: spacing.xl * 1.5,
    alignItems: 'center',
  },
  dropzoneActive: { borderColor: colors.accent, backgroundColor: colors.panelAlt },
  title: { color: colors.text, fontFamily: fonts.ui, fontSize: 20, fontWeight: '700', marginBottom: spacing.sm },
  subtitle: { color: colors.dim, fontFamily: fonts.ui, fontSize: 13, textAlign: 'center', marginBottom: spacing.sm },
  hint: { color: colors.faint, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center', marginBottom: spacing.lg },
  btn: {
    backgroundColor: colors.accentDim,
    borderRadius: 8,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#ffffff', fontFamily: fonts.ui, fontSize: 14, fontWeight: '600' },
  footnote: { color: colors.faint, fontFamily: fonts.ui, fontSize: 11, marginTop: spacing.lg, textAlign: 'center' },
});
