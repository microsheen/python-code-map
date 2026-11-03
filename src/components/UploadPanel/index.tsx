/**
 * 空态：上传入口（选择文件 + 拖拽区）与拉取入口（Pull from URL）。
 * 拖拽监听统一挂在 AppRoot（这样已有文件时也能继续拖入），这里只负责呈现。
 *
 * 拉取入口（issue #8）：与顶栏入口开同一个对话框（PullEntryDialog，开关在 store 的
 * pullEntryOpen），面板这一侧不再自己持有粘贴框。分流、请求推导、限额、报错分类
 * 全在 src/pull/ 与 store 里，组件不重复判断任何一条规则。
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
  const setPullEntryOpen = useAppStore((s) => s.setPullEntryOpen);
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
        <Text style={styles.title}>{'Python Code Map'}</Text>
        <Text style={styles.subtitle}>
          {'Upload .py files or pull from a URL to map functions and calls.'}
        </Text>
        <Text style={styles.hint}>
          {
            'Or drag files anywhere on the page. To pull from a URL, use Pull from URL here or in the top bar — both open the same dialog. Files you add stay in this browser and their contents are never sent anywhere; a request goes out only when you explicitly pull a file from a URL.'
          }
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
        <Pressable
          testID="upload-pull"
          style={[styles.btnGhost, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={() => setPullEntryOpen(true)}
        >
          <Text style={styles.btnGhostText}>{'Pull from URL'}</Text>
        </Pressable>
        <Text style={styles.footnote}>
          {
            'Max 20 files; single file limit 1MB; cross-file calls require related files to be uploaded together.'
          }
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
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
  title: {
    color: colors.text,
    fontFamily: fonts.ui,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.dim,
    fontFamily: fonts.ui,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  hint: {
    color: colors.faint,
    fontFamily: fonts.ui,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  btn: {
    backgroundColor: colors.accentDim,
    borderRadius: 8,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: colors.onAccent, fontFamily: fonts.ui, fontSize: 14, fontWeight: '600' },
  btnGhost: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: 'transparent',
  },
  btnGhostText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 13, fontWeight: '600' },
  footnote: {
    color: colors.faint,
    fontFamily: fonts.ui,
    fontSize: 11,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
});
