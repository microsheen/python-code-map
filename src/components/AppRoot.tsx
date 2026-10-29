/**
 * 应用根组件。
 *
 * 结构：TopBar + （空态 UploadPanel / 有文件时 SplitLayout）。
 * 全局拖拽监听挂在这里，这样"已有文件时继续拖入"也能工作；
 * 拖拽中的半透明遮罩只是视觉反馈，pointerEvents: 'none' 不拦截 drop。
 */
import { StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { subscribeDrop } from '../platform/web/filePick';
import { useAppStore } from '../state/store';
import { colors, fonts, spacing } from '../theme';
import { SplitLayout } from './SplitLayout';
import { TopBar } from './TopBar';
import { UploadPanel } from './UploadPanel';

export function AppRoot(): ReactNode {
  const addFiles = useAppStore((s) => s.addFiles);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const ctxMenu = useAppStore((s) => s.ctxMenu);
  const setCtxMenu = useAppStore((s) => s.setCtxMenu);
  const removeFile = useAppStore((s) => s.removeFile);
  const removeFiles = useAppStore((s) => s.removeFiles);
  const files = useAppStore((s) => s.files);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // 启动时尝试恢复上次会话
    void restoreSession();
  }, [restoreSession]);

  useEffect(() => {
    const sub = subscribeDrop((picked) => {
      if (picked.length > 0) void addFiles(picked);
    }, setDragging);
    return sub.unsubscribe;
    // addFiles 是 zustand action，引用恒定
  }, [addFiles]);

  const empty = files.length === 0;

  return (
    <View style={styles.root} testID="app-root">
      <TopBar />
      <View style={styles.body}>
        {empty ? <UploadPanel dragging={dragging} /> : <SplitLayout />}
      </View>
      {dragging ? (
        <View style={styles.overlay} testID="drop-overlay">
          <View style={styles.overlayBox}>
            <Text style={styles.overlayTitle}>Release to upload</Text>
            <Text style={styles.overlayHint}>.py / .pyi text files only (max 20)</Text>
          </View>
        </View>
      ) : null}
      {ctxMenu ? (
        <div
          data-testid="chip-context-menu"
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            backgroundColor: colors.raised,
            border: '1px solid ' + colors.borderStrong,
            borderRadius: 6,
            padding: '4px 0',
            minWidth: 140,
            zIndex: 10000,
            boxShadow: '0 4px 16px ' + colors.shadow,
          }}
        >
          <div
            data-testid="ctx-close"
            onClick={() => {
              void removeFile(ctxMenu.path);
              setCtxMenu(null);
            }}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              fontFamily: fonts.ui,
              color: colors.text,
              cursor: 'pointer',
              userSelect: 'none',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = colors.panel;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            Close
          </div>
          <div
            data-testid="ctx-close-others"
            onClick={() => {
              const keep = ctxMenu.path;
              const others = files.filter((f) => f.path !== keep);
              void removeFiles(others.map((f) => f.path)).then(() => setCtxMenu(null));
            }}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              fontFamily: fonts.ui,
              color: colors.text,
              cursor: 'pointer',
              userSelect: 'none',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = colors.panel;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            Close Others
          </div>
          <div
            data-testid="ctx-close-all"
            onClick={() => {
              void removeFiles(files.map((f) => f.path)).then(() => setCtxMenu(null));
            }}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              fontFamily: fonts.ui,
              color: colors.text,
              cursor: 'pointer',
              userSelect: 'none',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = colors.panel;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            Close All
          </div>
        </div>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, position: 'relative' },
  body: { flex: 1, overflow: 'hidden' },
  overlay: {
    // RN 0.78+ / RNW 0.21：pointerEvents 走 style，prop 形式已废弃
    pointerEvents: 'none',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  overlayBox: {
    borderWidth: 2,
    borderColor: colors.accent,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingHorizontal: spacing.xl * 2,
    paddingVertical: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.panel,
  },
  overlayTitle: { color: colors.text, fontFamily: fonts.ui, fontSize: 17, fontWeight: '700' },
  overlayHint: { color: colors.dim, fontFamily: fonts.ui, fontSize: 12 },
});





