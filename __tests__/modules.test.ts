/**
 * 模块索引：路径 -> dotted 模块名，以及 import spec -> 文件 的解析。
 */
import {
  absoluteSpec,
  buildModuleIndex,
  computePackageRoot,
  moduleNameOf,
  normalizePath,
  packageOf,
  resolveModuleSpec,
  resolveSubmodule,
} from '../src/parser/modules';

describe('normalizePath', () => {
  it('统一分隔符并去掉 ./ 与前导 /', () => {
    expect(normalizePath('a\\b\\c.py')).toBe('a/b/c.py');
    expect(normalizePath('./x/y.py')).toBe('x/y.py');
    expect(normalizePath('/root/y.py')).toBe('root/y.py');
    expect(normalizePath('  spaced.py  ')).toBe('spaced.py');
    expect(normalizePath('')).toBe('');
  });
});

describe('computePackageRoot', () => {
  it('取所有文件目录部分的最长公共前缀', () => {
    expect(computePackageRoot(['src/pkg/a.py', 'src/pkg/b.py'])).toBe('src/pkg');
    expect(computePackageRoot(['src/pkg/a.py', 'src/other/b.py'])).toBe('src');
    expect(computePackageRoot(['a/b/c/d.py'])).toBe('a/b/c');
  });

  it('零散文件（都在根目录）时前缀为空', () => {
    expect(computePackageRoot(['a.py', 'b.py'])).toBe('');
    expect(computePackageRoot([])).toBe('');
  });

  it('公共前缀本身就是包（存在 __init__.py）时上退一层，保留包名', () => {
    expect(computePackageRoot(['src/pkg/__init__.py', 'src/pkg/a.py'])).toBe('src');
    expect(computePackageRoot(['p/__init__.py', 'p/sub/__init__.py', 'p/sub/m.py'])).toBe('');
  });
});

describe('moduleNameOf', () => {
  it('a/b/c.py -> a.b.c（相对包根）', () => {
    expect(moduleNameOf('src/pkg/a/b/c.py', 'src/pkg/a')).toBe('b.c');
    expect(moduleNameOf('a/b/c.py', '')).toBe('a.b.c');
  });

  it('__init__.py 映射成包名本身', () => {
    expect(moduleNameOf('a/b/__init__.py', '')).toBe('a.b');
    expect(moduleNameOf('__init__.py', '')).toBe('');
  });

  it('支持 .pyi', () => {
    expect(moduleNameOf('a/b/stub.pyi', '')).toBe('a.b.stub');
  });
});

describe('buildModuleIndex + resolveModuleSpec', () => {
  it('零散上传：精确名、后缀名都能命中', () => {
    const idx = buildModuleIndex(['utils.py', 'shapes.py', 'main.py']);
    expect(idx.root).toBe('');
    expect(idx.moduleName.get('utils.py')).toBe('utils');
    expect(resolveModuleSpec('utils', idx)).toBe('utils.py');
    expect(resolveModuleSpec('main', idx)).toBe('main.py');
  });

  it('带包结构：绝对 spec 与后缀 spec 都解析到同一个文件', () => {
    const idx = buildModuleIndex(['top/pkg/a.py', 'top/pkg/b.py', 'top/x.py']);
    expect(idx.root).toBe('top');
    expect(idx.moduleName.get('top/pkg/a.py')).toBe('pkg.a');
    expect(resolveModuleSpec('pkg.a', idx)).toBe('top/pkg/a.py');
    expect(resolveModuleSpec('a', idx)).toBe('top/pkg/a.py');
  });

  it('同名文件在两个包里 -> 歧义，返回 null（宁可不连边）', () => {
    const idx = buildModuleIndex(['p1/utils.py', 'p2/utils.py']);
    expect(resolveModuleSpec('utils', idx)).toBeNull();
    expect(resolveModuleSpec('p1.utils', idx)).toBe('p1/utils.py');
  });

  it('按文件名尾段模糊兜底（用户只传了零散文件）', () => {
    const idx = buildModuleIndex(['a/b/helper.py', 'x.py']);
    expect(idx.byLastSegment.get('helper')).toEqual(['a/b/helper.py']);
    expect(resolveModuleSpec('other.helper', idx)).toBe('a/b/helper.py');
    expect(resolveModuleSpec('nope', idx)).toBeNull();
  });

  it('空 spec / 未知模块返回 null', () => {
    const idx = buildModuleIndex(['a.py']);
    expect(resolveModuleSpec('', idx)).toBeNull();
    expect(resolveModuleSpec('   ', idx)).toBeNull();
    expect(resolveModuleSpec('numpy', idx)).toBeNull();
  });

  it('resolveSubmodule 解析 from pkg import submod', () => {
    const idx = buildModuleIndex(['pkg/__init__.py', 'pkg/sub.py']);
    expect(idx.root).toBe('');
    expect(resolveSubmodule('pkg', 'sub', idx)).toBe('pkg/sub.py');
    expect(resolveSubmodule('', 'pkg', idx)).toBe('pkg/__init__.py');
    expect(resolveSubmodule('pkg', 'missing', idx)).toBeNull();
  });
});

describe('absoluteSpec / packageOf', () => {
  const idx = buildModuleIndex(['top/pkg/a.py', 'top/pkg/b.py', 'top/x.py']);

  it('level<=0 时原样返回', () => {
    expect(absoluteSpec('os.path', 0, 'top/pkg/a.py', idx)).toBe('os.path');
  });

  it('from . import x -> 当前包', () => {
    expect(absoluteSpec('', 1, 'top/pkg/a.py', idx)).toBe('pkg');
    expect(absoluteSpec('b', 1, 'top/pkg/a.py', idx)).toBe('pkg.b');
  });

  it('from .. import x -> 上一层包', () => {
    expect(absoluteSpec('x', 2, 'top/pkg/a.py', idx)).toBe('x');
  });

  it('__init__.py 里的相对 import 不再多退一层', () => {
    const i2 = buildModuleIndex(['top/pkg/__init__.py', 'top/pkg/b.py']);
    expect(absoluteSpec('b', 1, 'top/pkg/__init__.py', i2)).toBe('pkg.b');
  });

  it('packageOf 返回文件所属包', () => {
    expect(packageOf('top/pkg/a.py', idx)).toBe('pkg');
    expect(packageOf('top/x.py', idx)).toBe('');
  });
});
