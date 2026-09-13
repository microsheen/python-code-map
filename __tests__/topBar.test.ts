/**
 * TopBar 的纯函数：文件色下标。
 *
 * 图与代码颜色一致的约定所在，所以单独锁住。
 */
import { colorIndexOfFile } from '../src/components/TopBar';

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