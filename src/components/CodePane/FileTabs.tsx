/**
 * 文件标签栏：横向 chips，点击切换 activeFile；解析失败的文件带红点。
 * 右键标签弹出菜单：Close / Close Others / Close All。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppStore } from '../../state/store';
import { colors, fonts, spacing } from '../../theme';

/** 只取文件名（不含目录），标签栏空间有限。 */
export function shortName(p: string): string {
  const parts = (p || '').split('/');
  return parts[parts.length - 1] ?? p;
}

interface MenuPos {
  x: number;
  y: number;
  path: string;
}

type MenuItem = {
  label: string;
  disabled?: boolean;
  action: () => void;
};

export function FileTabs(): ReactNode {
  const files = useAppStore((s) => s.files);
  const activeFile = useAppStore((s) => s.activeFile);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const removeFile = useAppStore((s) => s.removeFile);

  const [menu, setMenu] = useState<MenuPos | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  // 点击菜单外部关闭
  useEffect(() => {
    if (!menu) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menu, closeMenu]);

  // ESC 关闭
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu, closeMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      console.log('[FileTabs] contextmenu triggered for:', path, 'at', e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, path });
    },
    [],
  );

  const buildItems = useCallback(
    (targetPath: string): MenuItem[] => {
      const total = files.length;
      const isLast = total <= 1;

      return [
        {
          label: 'Close',
          action: async () => {
            closeMenu();
            await removeFile(targetPath);
          },
        },
        {
          label: 'Close Others',
          disabled: total <= 1,
          action: async () => {
            closeMenu();
            const toRemove = files.filter((f) => f.path !== targetPath);
            for (const f of toRemove) {
              await removeFile(f.path);
            }
          },
        },
        {
          label: 'Close All',
          disabled: isLast,
          action: async () => {
            closeMenu();
            const allPaths = files.map((f) => f.path);
            for (const p of allPaths) {
              await removeFile(p);
            }
          },
        },
      ];
    },
    [files, closeMenu, removeFile],
  );

  if (files.length === 0) return null;

  console.log('[FileTabs] rendering', files.length, 'files, menu state:', menu);

  // 完全用原生 HTML，避免 RN 组件拦截事件
  return (
    <div
      data-testid="file-tabs"
      style={{
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        borderBottomStyle: 'solid',
        backgroundColor: colors.bg,
        maxHeight: 38,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          overflowX: 'auto',
          overflowY: 'hidden',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {files.map((f) => {
          const active = f.path === activeFile;
          return (
            <div
              key={f.path}
              data-testid={'file-tab-' + f.path}
              onClick={() => setActiveFile(f.path)}
              onContextMenu={(e) => handleContextMenu(e, f.path)}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.xs,
                paddingLeft: spacing.md,
                paddingRight: spacing.md,
                height: 32,
                borderRightWidth: 1,
                borderRightColor: colors.border,
                borderRightStyle: 'solid',
                cursor: 'pointer',
                backgroundColor: active ? colors.panel : 'transparent',
                borderBottomWidth: active ? 2 : 0,
                borderBottomColor: active ? colors.accent : 'transparent',
                borderBottomStyle: 'solid',
                flexShrink: 0,
                userSelect: 'none',
              }}
            >
              <span
                style={{
                  fontFamily: fonts.ui,
                  fontSize: 12,
                  color: active ? colors.text : colors.dim,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {shortName(f.path)}
              </span>
              {f.error ? (
                <span style={{ fontSize: 8, color: colors.danger, marginLeft: 2 }}>{'\u25cf'}</span>
              ) : null}
            </div>
          );
        })}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 9999,
            minWidth: 140,
            background: colors.panelAlt,
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 6,
            padding: '4px 0',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {buildItems(menu.path).map((item) => (
            <div
              key={item.label}
              onClick={() => !item.disabled && item.action()}
              style={{
                padding: '6px 16px',
                fontSize: 13,
                fontFamily: fonts.ui,
                color: item.disabled ? colors.faint : colors.text,
                cursor: item.disabled ? 'default' : 'pointer',
                userSelect: 'none',
                opacity: item.disabled ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (!item.disabled) (e.currentTarget as HTMLDivElement).style.background = colors.raised;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent';
              }}
            >
              {item.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
