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
        <Text style={styles.title}>{'Python Call Graph'}</Text>
        <Text style={styles.subtitle}>
          {'Upload one or more .py / .pyi files to parse function call relationships in the browser.'}
        </Text>
        <Text style={styles.hint}>
          {'Or drag files anywhere on the page. Code never leaves the browser. Files are cached locally for convenience.'}
        </Text>
        <Pressable
          testID="upload-pick"
          style={[styles.btn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={onPick}
        >
          <Text style={styles.btnText}>
            {busy ? 'Parsing ' + progress.done + '/' + progress.total : 'Select .py Files'}
          </Text>
        </Pressable>
        <Text style={styles.footnote}>
          {'Max 20 files; single file limit 1MB; cross-file calls require related files to be uploaded together.'}
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
