/**
 * TopBar 的纯函数：范围文案、统计文案、未解析明细、文件色下标。
 *
 * 这些字符串直接显示给用户，也是"图与代码颜色一致"的约定所在，
 * 所以单独锁住。
 */
import {
  REASON_LABELS,
  colorIndexOfFile,
  formatReasons,
  formatStats,
  scopeLabel,
} from '../src/components/TopBar';
import { ALL_SCOPE, fileScope, neighborhoodScope } from '../src/graph/scope';
import type { GraphStats, UnresolvedReason } from '../src/parser/types';

function stats(over: Partial<GraphStats> = {}): GraphStats {
  return {
    funcs: 12,
    edges: 9,
    unresolved: 4,
    ms: 37,
    byReason: { ambiguous: 1, external: 2, dynamic: 1, unknown: 0 },
    ...over,
  };
}

describe('REASON_LABELS', () => {
  it('四种未解析原因都有中文标签', () => {
    const reasons: UnresolvedReason[] = ['ambiguous', 'external', 'dynamic', 'unknown'];
    for (const r of reasons) {
      expect(typeof REASON_LABELS[r]).toBe('string');
      expect(REASON_LABELS[r].length).toBeGreaterThan(0);
    }
    expect(Object.keys(REASON_LABELS)).toHaveLength(4);
  });
});

describe('scopeLabel', () => {
  it('三种范围各自的文案', () => {
    expect(scopeLabel(neighborhoodScope('a.py::f'))).toBe('Neighborhood');
    expect(scopeLabel(fileScope('a.py'))).toBe('This File');
    expect(scopeLabel(ALL_SCOPE)).toBe('All');
  });

  it('邻域深度不影响文案', () => {
    expect(scopeLabel(neighborhoodScope('a.py::f', 3))).toBe('Neighborhood');
  });
});

describe('formatStats', () => {
  it('按 函数 / 连边 / 未解析 / 耗时 的顺序输出', () => {
    expect(formatStats(stats())).toBe('Functions 12  ·  Edges 9  ·  Unresolved 4  ·  Time 37ms');
  });

  it('全 0 时仍输出完整四项', () => {
    const s = stats({
      funcs: 0,
      edges: 0,
      unresolved: 0,
      ms: 0,
      byReason: { ambiguous: 0, external: 0, dynamic: 0, unknown: 0 },
    });
    expect(formatStats(s)).toBe('Functions 0  ·  Edges 0  ·  Unresolved 0  ·  Time 0ms');
  });
});

describe('formatReasons', () => {
  it('只列出非 0 的原因，顺序固定为 歧义/外部/动态/未知', () => {
    expect(formatReasons(stats())).toBe('Ambiguous 1  ·  External 2  ·  Dynamic 1');
  });

  it('全 0 时返回空串（工具栏不留空壳）', () => {
    expect(
      formatReasons(
        stats({ byReason: { ambiguous: 0, external: 0, dynamic: 0, unknown: 0 } }),
      ),
    ).toBe('');
  });

  it('单项非 0 时不带分隔符', () => {
    expect(
      formatReasons(stats({ byReason: { ambiguous: 0, external: 5, dynamic: 0, unknown: 0 } })),
    ).toBe('External 5');
  });

  it('byReason 缺字段按 0 处理', () => {
    const s = stats();
    delete (s.byReason as Partial<Record<UnresolvedReason, number>>).dynamic;
    expect(formatReasons(s)).toBe('Ambiguous 1  ·  External 2');
  });
});

describe('colorIndexOfFile', () => {
  const files = [{ path: 'a.py' }, { path: 'pkg/b.py' }, { path: 'c.py' }];

  it('优先用 graph.files 的顺序，与 GraphPane 着色一致', () => {
    const graphFiles = ['c.py', 'a.py', 'pkg/b.py'];
    expect(colorIndexOfFile(graphFiles, files, 'c.py')).toBe(0);
    expect(colorIndexOfFile(graphFiles, files, 'a.py')).toBe(1);
    expect(colorIndexOfFile(graphFiles, files, 'pkg/b.py')).toBe(2);
  });

  it('graphFiles 为 null 时退回上传文件顺序', () => {
    expect(colorIndexOfFile(null, files, 'a.py')).toBe(0);
    expect(colorIndexOfFile(null, files, 'pkg/b.py')).toBe(1);
    expect(colorIndexOfFile(null, files, 'c.py')).toBe(2);
  });

  it('未知路径（文件已被移除）退回 0，不返回 -1', () => {
    expect(colorIndexOfFile(null, files, 'gone.py')).toBe(0);
    expect(colorIndexOfFile(['a.py'], files, 'gone.py')).toBe(0);
  });

  it('空数组 -> 0', () => {
    expect(colorIndexOfFile([], [], 'a.py')).toBe(0);
  });
});
