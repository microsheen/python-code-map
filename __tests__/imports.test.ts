/**
 * import 绑定表与点号名拆分（纯函数部分；collectImports 需要 wasm，见 imports.wasm.test.ts）。
 */
import { buildImportTable, splitDotted, type ImportBinding } from '../src/parser/imports';

function mod(spec: string, localName: string, aliased = false, line = 1): ImportBinding {
  return { kind: 'module', spec, level: 0, line, localName, aliased };
}
function from(
  spec: string,
  localName: string,
  attr: string,
  level = 0,
  line = 1,
): ImportBinding {
  return { kind: 'from', spec, level, line, localName, attr };
}
function wild(spec: string, level = 0, line = 1): ImportBinding {
  return { kind: 'wildcard', spec, level, line };
}

describe('buildImportTable', () => {
  it('通配 import 进 wildcards，不占 byLocal', () => {
    const t = buildImportTable([wild('m'), mod('os', 'os')]);
    expect(t.wildcards).toHaveLength(1);
    expect(t.byLocal.has('m')).toBe(false);
    expect(t.byLocal.get('os')?.kind).toBe('module');
    expect(t.all).toHaveLength(2);
  });

  it('后写的同名绑定覆盖先写的（与 Python 运行时一致）', () => {
    const t = buildImportTable([from('a', 'f', 'f'), from('b', 'f', 'f')]);
    const b = t.byLocal.get('f');
    expect(b?.kind).toBe('from');
    if (b?.kind === 'from') expect(b.spec).toBe('b');
  });
});

describe('splitDotted', () => {
  it('import a.b.c 后写 a.b.c.f() -> 书写路径本身就是绝对的', () => {
    const t = buildImportTable([mod('a.b.c', 'a')]);
    expect(splitDotted('a.b.c.f', t)).toEqual({
      spec: 'a.b.c',
      attr: 'f',
      level: 0,
      viaImport: true,
    });
  });

  it('import numpy as np：np.f() 基于 spec 重新拼接', () => {
    const t = buildImportTable([mod('numpy', 'np', true)]);
    expect(splitDotted('np', t)).toEqual({
      spec: 'numpy',
      attr: '',
      level: 0,
      viaImport: true,
    });
    expect(splitDotted('np.array', t)).toEqual({
      spec: 'numpy',
      attr: 'array',
      level: 0,
      viaImport: true,
    });
    expect(splitDotted('np.linalg.svd', t)).toEqual({
      spec: 'numpy.linalg',
      attr: 'svd',
      level: 0,
      viaImport: true,
    });
  });

  it('from m import f [as g]：直接名字取源模块属性', () => {
    const t = buildImportTable([from('m', 'f', 'f'), from('m', 'g', 'real_f')]);
    expect(splitDotted('f', t)).toEqual({
      spec: 'm',
      attr: 'f',
      level: 0,
      viaImport: true,
    });
    expect(splitDotted('g', t)).toEqual({
      spec: 'm',
      attr: 'real_f',
      level: 0,
      viaImport: true,
    });
  });

  it('相对 import 保留 level，交给 absoluteSpec 再解析', () => {
    const t = buildImportTable([from('', 'sib', 'sib', 1), from('pkg', 'sub', 'sub', 2)]);
    expect(splitDotted('sib', t)).toEqual({
      spec: '',
      attr: 'sib',
      level: 1,
      viaImport: true,
    });
    expect(splitDotted('sub', t)).toEqual({
      spec: 'pkg',
      attr: 'sub',
      level: 2,
      viaImport: true,
    });
  });

  it('from m import obj 后写 obj.method() -> 基于 attr 继续拼', () => {
    const t = buildImportTable([from('m', 'obj', 'Klass')]);
    expect(splitDotted('obj.method', t)).toEqual({
      spec: 'm.Klass',
      attr: 'method',
      level: 0,
      viaImport: true,
    });
  });

  it('通配 import 只进 .wildcards、不占 byLocal：裸名走隐式猜测', () => {
    const t = buildImportTable([wild('m')]);
    // wildcard 不写入 byLocal，所以任何名字都不会被当成 import 绑定，
    // 而是走 viaImport=false 的后缀猜测（真正的通配解析在 resolveSimpleName 里做）。
    expect(t.byLocal.has('m')).toBe(false);
    expect(t.wildcards).toHaveLength(1);
    expect(splitDotted('m', t)).toEqual({
      spec: '',
      attr: 'm',
      level: 0,
      viaImport: false,
    });
  });

  it('没有 import 的名字：给出后缀猜测并标记 viaImport=false', () => {
    const t = buildImportTable([]);
    expect(splitDotted('foo.bar', t)).toEqual({
      spec: 'foo',
      attr: 'bar',
      level: 0,
      viaImport: false,
    });
    expect(splitDotted('zzz', t)).toEqual({
      spec: '',
      attr: 'zzz',
      level: 0,
      viaImport: false,
    });
  });

  it('空串 -> null', () => {
    expect(splitDotted('', buildImportTable([]))).toBeNull();
  });
});
