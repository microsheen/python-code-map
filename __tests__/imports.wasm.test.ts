/**
 * collectImports 的真实语法树测试（纯函数部分见 imports.test.ts）。
 *
 * 覆盖计划里列出的全部 import 写法：import x / import a.b as c /
 * from m import f / from m import f as g / from . import f / from .m import f /
 * from m import *，以及一行多目标。
 */
import { buildImportTable, collectImports, splitDotted } from '../src/parser/imports';
import type { ImportBinding } from '../src/parser/imports';
import { describeWasm, parseSource } from './helpers/wasm';

const SRC = [
  'import os',
  'import a.b as c',
  'from m import f',
  'from m import g as h',
  'from . import sib',
  'from .sub import deep',
  'from multi import p, q as r',
  'from lib import *',
  '',
].join('\n');

function findMod(bs: ImportBinding[], localName: string): ImportBinding {
  const hit = bs.find((b) => b.kind === 'module' && b.localName === localName);
  if (!hit) throw new Error('没有 module 绑定 ' + localName + '，实际：' + JSON.stringify(bs));
  return hit;
}

function findFrom(bs: ImportBinding[], localName: string): ImportBinding {
  const hit = bs.find((b) => b.kind === 'from' && b.localName === localName);
  if (!hit) throw new Error('没有 from 绑定 ' + localName + '，实际：' + JSON.stringify(bs));
  return hit;
}

describeWasm('collectImports（真实语法树）', () => {
  it('八行 import 产出九个绑定，通配单独归类', async () => {
    const root = await parseSource(SRC);
    const bs = collectImports(root);

    expect(bs.map((b) => b.kind)).toEqual([
      'module',
      'module',
      'from',
      'from',
      'from',
      'from',
      'from',
      'from',
      'wildcard',
    ]);

    // import os
    const os = findMod(bs, 'os');
    expect(os).toMatchObject({ kind: 'module', spec: 'os', localName: 'os', aliased: false, line: 1 });

    // import a.b as c：spec 保留完整点号路径，aliased 标记为真
    const c = findMod(bs, 'c');
    expect(c).toMatchObject({ kind: 'module', spec: 'a.b', localName: 'c', aliased: true, line: 2 });

    // from m import f
    expect(findFrom(bs, 'f')).toMatchObject({
      kind: 'from',
      spec: 'm',
      level: 0,
      attr: 'f',
      localName: 'f',
      line: 3,
    });

    // from m import g as h：attr 是原名，localName 是别名
    expect(findFrom(bs, 'h')).toMatchObject({
      kind: 'from',
      spec: 'm',
      level: 0,
      attr: 'g',
      localName: 'h',
      line: 4,
    });

    // from . import sib：level 1、spec 为空
    expect(findFrom(bs, 'sib')).toMatchObject({
      kind: 'from',
      spec: '',
      level: 1,
      attr: 'sib',
      localName: 'sib',
      line: 5,
    });

    // from .sub import deep：level 1 + spec 'sub'
    expect(findFrom(bs, 'deep')).toMatchObject({
      kind: 'from',
      spec: 'sub',
      level: 1,
      attr: 'deep',
      localName: 'deep',
      line: 6,
    });

    // 一行多目标 -> 两个独立绑定
    expect(findFrom(bs, 'p')).toMatchObject({ spec: 'multi', attr: 'p', localName: 'p', line: 7 });
    expect(findFrom(bs, 'r')).toMatchObject({ spec: 'multi', attr: 'q', localName: 'r', line: 7 });

    // from lib import *
    const wild = bs.find((b) => b.kind === 'wildcard');
    expect(wild).toMatchObject({ kind: 'wildcard', spec: 'lib', level: 0, line: 8 });
  });

  it('绑定表能直接喂给 splitDotted，别名与 from-as 都还原成源模块属性', async () => {
    const root = await parseSource(SRC);
    const table = buildImportTable(collectImports(root));

    // 通配不占 byLocal，其余八个名字都在
    expect(table.wildcards).toHaveLength(1);
    for (const name of ['os', 'c', 'f', 'h', 'sib', 'deep', 'p', 'r']) {
      expect(table.byLocal.has(name)).toBe(true);
    }

    // import a.b as c -> c.fn() 指向 a.b 的 fn
    expect(splitDotted('c.fn', table)).toEqual({
      spec: 'a.b',
      attr: 'fn',
      level: 0,
      viaImport: true,
    });

    // from multi import q as r -> r.method() 指向 multi.q 的 method
    expect(splitDotted('r.method', table)).toEqual({
      spec: 'multi.q',
      attr: 'method',
      level: 0,
      viaImport: true,
    });

    // 相对 import 保留 level，交给 absoluteSpec
    expect(splitDotted('deep', table)).toEqual({
      spec: 'sub',
      attr: 'deep',
      level: 1,
      viaImport: true,
    });
  });
});
