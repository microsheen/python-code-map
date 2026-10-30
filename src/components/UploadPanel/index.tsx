/**
 * 空态：上传入口（选择文件 + 拖拽区）与拉取入口（Pull from URL）。
 * 拖拽监听统一挂在 AppRoot（这样已有文件时也能继续拖入），这里只负责呈现。
 *
 * 拉取入口（issue #4）：点开后是一个多行粘贴框，一行一条 URL。这一层只做两件事 ——
 * 把原文交给 store 的 pullFromText，以及在拉取进行中禁用确认按钮；
 * 分流、请求推导、限额、报错分类全在 src/pull/ 与 store 里，组件不重复判断任何一条规则。
 * 顶栏入口是 #8 的活，本轮不做。
 */
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';
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
  const pullFromText = useAppStore((s) => s.pullFromText);
  const pulling = useAppStore((s) => s.pulling);
  const status = useAppStore((s) => s.status);
  const progress = useAppStore((s) => s.progress);
  const busy = status === 'loading-wasm' || status === 'parsing';
  const [pullOpen, setPullOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const onPick = (): void => {
    void pickFiles().then((picked) => {
      if (picked.length > 0) void addFiles(picked);
    });
  };

  const onSubmitPull = (): void => {
    // 空粘贴不触发：连一句提示都不必走一趟 store
    if (draft.trim().length === 0) return;
    const text = draft;
    void pullFromText(text).then(() => {
      setDraft('');
      setPullOpen(false);
    });
  };

  return (
    <View style={styles.wrap} testID="upload-panel">
      <View style={[styles.dropzone, dragging && styles.dropzoneActive]} testID="upload-dropzone">
        <Text style={styles.title}>{'Python Call Graph'}</Text>
        <Text style={styles.subtitle}>
          {
            'Upload one or more .py / .pyi files to parse function call relationships in the browser.'
          }
        </Text>
        <Text style={styles.hint}>
          {
            'Or drag files anywhere on the page. Files you add stay in this browser and their contents are never sent anywhere; a request goes out only when you explicitly pull a file from a URL.'
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
          onPress={() => setPullOpen((v) => !v)}
        >
          <Text style={styles.btnGhostText}>{'Pull from URL'}</Text>
        </Pressable>
        {pullOpen ? (
          <View style={styles.pullBox} testID="pull-box">
            <Text style={styles.pullHint}>
              {
                'One https:// link per line, each pointing straight at a .py or .pyi file. A request goes out for each line you pull; the request body is always empty.'
              }
            </Text>
            <TextInput
              testID="pull-input"
              style={styles.pullInput}
              value={draft}
              onChangeText={setDraft}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder={'https://example.com/project/module.py'}
              placeholderTextColor={colors.faint}
            />
            <View style={styles.pullRow}>
              <Pressable
                testID="pull-submit"
                style={[styles.btn, (pulling || busy) && styles.btnDisabled]}
                disabled={pulling || busy}
                onPress={onSubmitPull}
              >
                <Text style={styles.btnText}>{pulling ? 'Pulling…' : 'Pull'}</Text>
              </Pressable>
              <Pressable
                testID="pull-cancel"
                style={styles.btnGhost}
                onPress={() => {
                  setPullOpen(false);
                  setDraft('');
                }}
              >
                <Text style={styles.btnGhostText}>{'Cancel'}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
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
  pullBox: {
    width: '100%',
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    // 不写 borderTopStyle：RN 的 ViewStyle 类型里没有这条（CSS 默认就是 solid）
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'stretch',
  },
  pullHint: { color: colors.faint, fontFamily: fonts.ui, fontSize: 11, marginBottom: spacing.sm },
  pullInput: {
    width: '100%',
    minHeight: 84,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    padding: spacing.sm,
  },
  pullRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  footnote: {
    color: colors.faint,
    fontFamily: fonts.ui,
    fontSize: 11,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
});
