/**
 * 解析管线的真实 wasm 集成测试。
 *
 * 分工：纯函数层（modules / imports / buildGraph / scope / layout / store）各有自己的测试，
 * 这里只覆盖"必须有真语法树才有意义"的部分：
 *   1. fixtures 三文件样例的全量统计（回归基线）
 *   2. 语法错误容错：坏文件降级为 warning，其余文件照常出图
 *   3. 符号行列范围：装饰器、类方法、嵌套函数、async def
 *   4. 调用解析矩阵：每条都断言 target 与 reason
 *   5. 高亮 span 的列范围
 *
 * public/wasm 缺失时整个文件跳过（见 helpers/wasm.ts）。
 */
import { analyzeFiles } from '../src/parser/analyze';
import { moduleId } from '../src/parser/symbols';
import type { AnalysisResult, CallSite, FuncSymbol, PyFile } from '../src/parser/types';
import { describeWasm, fixtureFile, getTestParser, sourceFile } from './helpers/wasm';

/** 测试里不需要真的让出主线程，避免每个用例都等 setTimeout */
const FAST = { yieldControl: async () => {} };

function py(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

async function analyze(...files: PyFile[]): Promise<AnalysisResult> {
  const parser = await getTestParser();
  return analyzeFiles(files, parser, FAST);
}

/** 某文件的全部调用点（文档顺序） */
function sitesOf(r: AnalysisResult, file: string): CallSite[] {
  return r.analyses.filter((a) => a.file.path === file).flatMap((a) => a.calls);
}

/** 按 文件 + 被调表达式原文 取第 nth 个调用点；找不到时把实际内容打出来便于定位 */
function site(r: AnalysisResult, file: string, text: string, nth = 0): CallSite {
  const hits = sitesOf(r, file).filter((c) => c.text === text);
  const found = hits[nth];
  if (!found) {
    throw new Error(
      '未找到调用点 ' + file + ' / "' + text + '"[' + nth + ']，实际有 ' + hits.length + ' 个；' +
        '该文件全部调用点：' + JSON.stringify(sitesOf(r, file).map((c) => c.text + ':' + c.reason)),
    );
  }
  return found;
}

function funcOf(r: AnalysisResult, file: string, qualifiedName: string): FuncSymbol {
  const a = r.analyses.find((x) => x.file.path === file);
  const hit = a?.funcs.find((f) => f.qualifiedName === qualifiedName);
  if (!hit) {
    throw new Error(
      '未找到函数 ' + file + '::' + qualifiedName + '，实际有：' +
        JSON.stringify((a?.funcs ?? []).map((f) => f.qualifiedName)),
    );
  }
  return hit;
}

function edgeOf(r: AnalysisResult, source: string, target: string) {
  return r.graph.edges.find((e) => e.source === source && e.target === target);
}

function nodeIds(r: AnalysisResult, file?: string): string[] {
  return r.graph.nodes
    .filter((n) => (file === undefined ? true : n.file === file))
    .map((n) => n.qualifiedName)
    .sort();
}

describeWasm('fixtures：三文件样例项目（回归基线）', () => {
  let r: AnalysisResult;

  beforeAll(async () => {
    r = await analyze(fixtureFile('utils.py'), fixtureFile('shapes.py'), fixtureFile('main.py'));
  });

  it('统计数字与基线一致', () => {
    expect(r.graph.stats.funcs).toBe(45);
    expect(r.graph.stats.edges).toBe(49);
    expect(r.graph.stats.unresolved).toBe(26);
    expect(r.graph.stats.byReason).toEqual({
      ambiguous: 1,
      external: 14,
      dynamic: 11,
      unknown: 0,
    });
    expect(r.graph.stats.ms).toBeGreaterThanOrEqual(0);
    expect([...r.graph.files].sort()).toEqual(['main.py', 'shapes.py', 'utils.py']);
  });

  it('跨文件 import 连边：import utils / import shapes as sh', () => {
    expect(edgeOf(r, 'main.py::boot', 'utils.py::load_config')).toBeDefined();
    expect(edgeOf(r, 'main.py::boot', 'shapes.py::helper')).toBeDefined();
    expect(edgeOf(r, 'main.py::boot', 'main.py::log')).toBeDefined();
  });

  it('from ... import 连边：calc / clamp / total_area', () => {
    expect(edgeOf(r, 'main.py::report', 'utils.py::calc')).toBeDefined();
    expect(edgeOf(r, 'main.py::report', 'utils.py::clamp')).toBeDefined();
    expect(edgeOf(r, 'main.py::draw', 'shapes.py::total_area')).toBeDefined();
  });

  it('构造函数连到 __init__，变量接收者记为 dynamic 且不连边', () => {
    expect(edgeOf(r, 'main.py::draw', 'shapes.py::Circle.__init__')).toBeDefined();
    expect(site(r, 'main.py', 'c.describe').reason).toBe('dynamic');
    expect(site(r, 'main.py', 'c.describe').target).toBeNull();
  });

  it('递归是自环，嵌套函数进图并各自连边', () => {
    const loop = edgeOf(r, 'main.py::factorial', 'main.py::factorial');
    expect(loop?.selfLoop).toBe(true);
    expect(nodeIds(r, 'main.py')).toEqual(
      expect.arrayContaining(['outer', 'outer.run', 'outer.step', 'factorial']),
    );
    expect(edgeOf(r, 'main.py::outer', 'main.py::outer.run')).toBeDefined();
    expect(edgeOf(r, 'main.py::outer.run', 'main.py::outer.step')).toBeDefined();
    expect(edgeOf(r, 'main.py::outer.step', 'utils.py::clamp')).toBeDefined();
  });

  it('同一对函数的多次调用合并成一条边，selfLoop 与 source===target 一致', () => {
    const merged = r.graph.edges.filter(
      (e) => e.source === 'main.py::report' && e.target === 'utils.py::clamp',
    );
    expect(merged).toHaveLength(1);
    for (const e of r.graph.edges) {
      expect(e.callSites.length).toBeGreaterThanOrEqual(1);
      expect(e.selfLoop).toBe(e.source === e.target);
    }
  });

  it('三个样例文件本身没有语法错误', () => {
    for (const f of r.files) expect(f.error).toBeUndefined();
    for (const a of r.analyses) expect(a.syntaxErrors).toBe(0);
  });
});

describeWasm('容错：语法错误文件', () => {
  it('坏文件降级为 warning，但仍尽力解析出可用符号', async () => {
    const r = await analyze(fixtureFile('broken.py'));
    const broken = r.files.find((f) => f.path === 'broken.py');
    expect(broken?.error).toBe('存在 1 处语法错误，已尽力解析（结果可能不完整）');

    const a = r.analyses.find((x) => x.file.path === 'broken.py');
    expect(a?.syntaxErrors).toBeGreaterThanOrEqual(1);
    expect(nodeIds(r, 'broken.py')).toEqual(['ok_part', 'still_ok']);
    // 错误行之后写的调用照样能连上
    expect(edgeOf(r, 'broken.py::still_ok', 'broken.py::ok_part')).toBeDefined();
  });

  it('一个文件坏掉不影响其余文件出图', async () => {
    const good = sourceFile('good.py', py('def g():', '    return 1'));
    const r = await analyze(fixtureFile('broken.py'), good);

    expect(r.files.find((f) => f.path === 'good.py')?.error).toBeUndefined();
    expect(nodeIds(r, 'good.py')).toEqual(['g']);
    expect(r.analyses.find((x) => x.file.path === 'good.py')?.syntaxErrors).toBe(0);
    expect(r.files.find((f) => f.path === 'broken.py')?.error).toBeTruthy();
  });
});

describeWasm('符号收集：行列范围', () => {
  const DEC_SRC = py(
    'import dataclasses',
    '',
    '@dataclasses.dataclass',
    'class Point:',
    '    x: float',
    '    y: float',
    '    @property',
    '    def norm(self) -> float:',
    '        return (self.x ** 2 + self.y ** 2) ** 0.5',
    '',
    '    def shifted(self, d):',
    '        def apply(v):',
    '            return v + d',
    '        return apply(self.x)',
    '',
    'async def fetch(url):',
    '    return url',
  );

  let r: AnalysisResult;
  beforeAll(async () => {
    r = await analyze(sourceFile('p.py', DEC_SRC));
  });

  it('装饰器算进 startLine，defLine 仍是 def 那一行', () => {
    expect(funcOf(r, 'p.py', 'Point.norm')).toMatchObject({
      kind: 'method',
      className: 'Point',
      depth: 1,
      defLine: 8,
      startLine: 7,
      endLine: 9,
      decorators: ['property'],
      params: ['self'],
      nameRange: { startLine: 8, startCol: 8, endLine: 8, endCol: 12 },
    });
  });

  it('类方法内嵌套的函数：限定名三段，className 仍指向外层类', () => {
    expect(funcOf(r, 'p.py', 'Point.shifted')).toMatchObject({
      defLine: 11,
      startLine: 11,
      endLine: 14,
      params: ['self', 'd'],
    });
    expect(funcOf(r, 'p.py', 'Point.shifted.apply')).toMatchObject({
      kind: 'method',
      className: 'Point',
      depth: 2,
      defLine: 12,
      startLine: 12,
      endLine: 13,
      nameRange: { startLine: 12, startCol: 12, endLine: 12, endCol: 17 },
    });
  });

  it('async def 记为 async，返回类型注解不进 params', () => {
    expect(funcOf(r, 'p.py', 'fetch')).toMatchObject({
      kind: 'async',
      className: null,
      depth: 0,
      defLine: 16,
      startLine: 16,
      endLine: 17,
      params: ['url'],
      nameRange: { startLine: 16, startCol: 10, endLine: 16, endCol: 15 },
    });
  });

  it('类符号记录起止行与基类', () => {
    const a = r.analyses.find((x) => x.file.path === 'p.py');
    expect(a?.classes).toHaveLength(1);
    expect(a?.classes[0]).toMatchObject({
      id: 'p.py::Point',
      name: 'Point',
      startLine: 3,
      endLine: 14,
      bases: [],
    });
  });

  it('每个文件都有 <module> 伪函数；没有模块级调用时不进图', () => {
    const a = r.analyses.find((x) => x.file.path === 'p.py');
    expect(a?.moduleFunc.id).toBe(moduleId('p.py'));
    expect(a?.moduleFunc.synthetic).toBe(true);
    expect(nodeIds(r, 'p.py')).not.toContain('<module>');
  });
});

describeWasm('调用解析矩阵', () => {
  it('M1 同文件直调 + 递归自环', async () => {
    const r = await analyze(
      sourceFile(
        'rec.py',
        py(
          'def factorial(n):',
          '    if n <= 1:',
          '        return 1',
          '    return n * factorial(n - 1)',
          '',
          '',
          'def top():',
          '    return factorial(3)',
        ),
      ),
    );
    expect(site(r, 'rec.py', 'factorial', 0)).toMatchObject({
      caller: 'rec.py::factorial',
      target: 'rec.py::factorial',
      reason: 'resolved',
      line: 4,
    });
    expect(site(r, 'rec.py', 'factorial', 1)).toMatchObject({
      caller: 'rec.py::top',
      target: 'rec.py::factorial',
      reason: 'resolved',
      line: 8,
    });
    expect(edgeOf(r, 'rec.py::factorial', 'rec.py::factorial')?.selfLoop).toBe(true);
    expect(edgeOf(r, 'rec.py::top', 'rec.py::factorial')?.callSites).toHaveLength(1);
  });

  it('M2 import b 之后 b.f() 连到另一个上传文件', async () => {
    const r = await analyze(
      sourceFile('b.py', py('def f():', '    return 1')),
      sourceFile('m2.py', py('import b', '', '', 'def g():', '    return b.f()')),
    );
    expect(site(r, 'm2.py', 'b.f')).toMatchObject({
      caller: 'm2.py::g',
      target: 'b.py::f',
      reason: 'resolved',
    });
    expect(edgeOf(r, 'm2.py::g', 'b.py::f')).toBeDefined();
  });

  it('M3 from m import f 之后裸名直调', async () => {
    const r = await analyze(
      sourceFile('m3.py', py('def f():', '    return 1')),
      sourceFile('u3.py', py('from m3 import f', '', '', 'def g():', '    return f()')),
    );
    expect(site(r, 'u3.py', 'f')).toMatchObject({
      caller: 'u3.py::g',
      target: 'm3.py::f',
      reason: 'resolved',
    });
  });

  it('M4 import pkg.lib as c 别名：c.fn() 走包内路径', async () => {
    const r = await analyze(
      sourceFile('top/x.py', py('TOP = 1')),
      sourceFile('top/pkg/lib.py', py('def fn():', '    return 1')),
      sourceFile(
        'top/pkg/caller.py',
        py('import pkg.lib as c', '', '', 'def go():', '    return c.fn()'),
      ),
    );
    expect(site(r, 'top/pkg/caller.py', 'c.fn')).toMatchObject({
      caller: 'top/pkg/caller.py::go',
      target: 'top/pkg/lib.py::fn',
      reason: 'resolved',
    });
  });

  it('M5 相对 import：from . import b 与 from .m import helper', async () => {
    const r = await analyze(
      sourceFile('top/x.py', py('TOP = 1')),
      sourceFile('top/pkg/b.py', py('def fn():', '    return 1')),
      sourceFile('top/pkg/m5.py', py('def helper():', '    return 2')),
      sourceFile(
        'top/pkg/a.py',
        py(
          'from . import b',
          'from .m5 import helper',
          '',
          '',
          'def go():',
          '    return b.fn() + helper()',
        ),
      ),
    );
    expect(site(r, 'top/pkg/a.py', 'b.fn')).toMatchObject({
      target: 'top/pkg/b.py::fn',
      reason: 'resolved',
    });
    expect(site(r, 'top/pkg/a.py', 'helper')).toMatchObject({
      target: 'top/pkg/m5.py::helper',
      reason: 'resolved',
    });
  });

  it('M6 self.method() 解析到同一个类的方法', async () => {
    const r = await analyze(
      sourceFile(
        'k.py',
        py(
          'class K:',
          '    def a(self):',
          '        return self.b()',
          '',
          '    def b(self):',
          '        return 1',
        ),
      ),
    );
    expect(site(r, 'k.py', 'self.b')).toMatchObject({
      caller: 'k.py::K.a',
      target: 'k.py::K.b',
      reason: 'resolved',
    });
    expect(edgeOf(r, 'k.py::K.a', 'k.py::K.b')).toBeDefined();
  });

  it('M7 Cls.static() 类名前缀解析到类方法', async () => {
    const r = await analyze(
      sourceFile(
        'cs.py',
        py(
          'class Calc:',
          '    @staticmethod',
          '    def run(x):',
          '        return x',
          '',
          '',
          'def use():',
          '    return Calc.run(1)',
        ),
      ),
    );
    expect(site(r, 'cs.py', 'Calc.run')).toMatchObject({
      caller: 'cs.py::use',
      target: 'cs.py::Calc.run',
      reason: 'resolved',
    });
  });

  it('M8 Cls() 构造函数解析到 __init__', async () => {
    const r = await analyze(
      sourceFile(
        'ctor.py',
        py(
          'class Box:',
          '    def __init__(self, v):',
          '        self.v = v',
          '',
          '',
          'def make():',
          '    return Box(1)',
        ),
      ),
    );
    expect(site(r, 'ctor.py', 'Box')).toMatchObject({
      caller: 'ctor.py::make',
      target: 'ctor.py::Box.__init__',
      reason: 'resolved',
    });
  });

  it('M8.1 ClassName().method() 解析到类方法', async () => {
    const r = await analyze(
      sourceFile(
        'ctor_method.py',
        py(
          'class AwsSecretService:',
          '    def get_secret(self, id: str, region: str) -> str:',
          '        return ""',
          '',
          '',
          'class CommonService:',
          '    def __init__(self):',
          '        secret = AwsSecretService().get_secret("id", "region")',
        ),
      ),
    );
    expect(site(r, 'ctor_method.py', 'AwsSecretService().get_secret')).toMatchObject({
      caller: 'ctor_method.py::CommonService.__init__',
      target: 'ctor_method.py::AwsSecretService.get_secret',
      reason: 'resolved',
    });
    expect(edgeOf(r, 'ctor_method.py::CommonService.__init__', 'ctor_method.py::AwsSecretService.get_secret')).toBeDefined();
  });
  it('M9 同名多候选 -> ambiguous，宁可不连边', async () => {
    const r = await analyze(
      sourceFile(
        'amb.py',
        py(
          'class A:',
          '    def run(self):',
          '        return 1',
          '',
          '',
          'class B:',
          '    def run(self):',
          '        return 2',
          '',
          '',
          'def go():',
          '    return run()',
        ),
      ),
    );
    const s = site(r, 'amb.py', 'run');
    expect(s.reason).toBe('ambiguous');
    expect(s.target).toBeNull();
    expect(edgeOf(r, 'amb.py::go', 'amb.py::A.run')).toBeUndefined();
    expect(edgeOf(r, 'amb.py::go', 'amb.py::B.run')).toBeUndefined();
    expect(r.graph.stats.byReason.ambiguous).toBe(1);
  });

  it('M10 内置函数与未上传的第三方模块 -> external', async () => {
    const r = await analyze(
      sourceFile(
        'ext.py',
        py(
          'import requests',
          '',
          '',
          'def go():',
          '    print(len("x"))',
          '    return requests.get("u")',
        ),
      ),
    );
    expect(site(r, 'ext.py', 'print')).toMatchObject({ target: null, reason: 'external' });
    expect(site(r, 'ext.py', 'len')).toMatchObject({ target: null, reason: 'external' });
    expect(site(r, 'ext.py', 'requests.get')).toMatchObject({ target: null, reason: 'external' });
    expect(r.graph.edges).toHaveLength(0);
    expect(r.graph.stats.byReason.external).toBe(3);
  });

  it('M11 局部变量接收者与 getattr -> dynamic', async () => {
    const r = await analyze(
      sourceFile(
        'dyn.py',
        py(
          'def go(obj, name):',
          '    handler = obj.factory',
          '    handler(1)',
          '    return getattr(obj, name)()',
        ),
      ),
    );
    expect(site(r, 'dyn.py', 'handler')).toMatchObject({ target: null, reason: 'dynamic' });

    const outer = sitesOf(r, 'dyn.py').find((c) => c.text.startsWith('getattr'));
    if (!outer) {
      throw new Error(
        '未找到 getattr 调用点，实际：' + JSON.stringify(sitesOf(r, 'dyn.py').map((c) => c.text)),
      );
    }
    expect(outer.reason).toBe('dynamic');
    expect(outer.target).toBeNull();
    expect(r.graph.edges).toHaveLength(0);
  });

  it('M12 模块级调用的 caller 是 <module> 伪函数，并因此进图', async () => {
    const r = await analyze(
      sourceFile('mod.py', py('def helper():', '    return 1', '', '', 'VALUE = helper()')),
    );
    expect(site(r, 'mod.py', 'helper')).toMatchObject({
      caller: moduleId('mod.py'),
      target: 'mod.py::helper',
      reason: 'resolved',
    });
    expect(edgeOf(r, moduleId('mod.py'), 'mod.py::helper')).toBeDefined();
    expect(nodeIds(r, 'mod.py')).toEqual(['<module>', 'helper']);
  });

  it('M13 嵌套函数内调用文件级函数，外层调用内层', async () => {
    const r = await analyze(
      sourceFile(
        'nest.py',
        py(
          'def helper(v):',
          '    return v',
          '',
          '',
          'def outer(x):',
          '    def inner(y):',
          '        return helper(y)',
          '',
          '    return inner(x)',
        ),
      ),
    );
    expect(site(r, 'nest.py', 'helper')).toMatchObject({
      caller: 'nest.py::outer.inner',
      target: 'nest.py::helper',
      reason: 'resolved',
    });
    expect(site(r, 'nest.py', 'inner')).toMatchObject({
      caller: 'nest.py::outer',
      target: 'nest.py::outer.inner',
      reason: 'resolved',
    });
  });

  it('M14 通配 import：目标模块内唯一同名定义时连边', async () => {
    const r = await analyze(
      sourceFile('wsrc.py', py('def only():', '    return 1')),
      sourceFile('wuse.py', py('from wsrc import *', '', '', 'def go():', '    return only()')),
    );
    expect(site(r, 'wuse.py', 'only')).toMatchObject({
      caller: 'wuse.py::go',
      target: 'wsrc.py::only',
      reason: 'resolved',
    });
  });

  it('M15 子类里的 self.method() 沿基类链找到父类实现', async () => {
    const r = await analyze(
      sourceFile(
        'inh.py',
        py(
          'class Base:',
          '    def shared(self):',
          '        return 1',
          '',
          '',
          'class Child(Base):',
          '    def use(self):',
          '        return self.shared()',
        ),
      ),
    );
    expect(site(r, 'inh.py', 'self.shared')).toMatchObject({
      caller: 'inh.py::Child.use',
      target: 'inh.py::Base.shared',
      reason: 'resolved',
    });
  });

    it('M16 模块级变量 = 构造器() -> VAR.method() 解析为 Class.method', async () => {
      const r = await analyze(
        sourceFile(
          'mvt.py',
          py(
            'class TaskStore:',
            '    def create(self, subject: str) -> str:',
            '        return ""',
            '',
            '',
            'TASKS = TaskStore("/tmp")',
            '',
            '',
            'def create_task(subject: str) -> str:',
            '    return TASKS.create(subject)',
          ),
        ),
      );
      // TASKS.create 应解析为 TaskStore.create
      expect(site(r, 'mvt.py', 'TASKS.create')).toMatchObject({
        caller: 'mvt.py::create_task',
        target: 'mvt.py::TaskStore.create',
        reason: 'resolved',
      });
      // 应产生一条边 create_task -> TaskStore.create
      expect(edgeOf(r, 'mvt.py::create_task', 'mvt.py::TaskStore.create')).toBeDefined();
    });

    it('M17 模块级变量被多次赋值时类型不确定，不连边', async () => {
      const r = await analyze(
        sourceFile(
          'mvt2.py',
          py(
            'class A:',
            '    def run(self):',
            '        return 1',
            '',
            '',
            'class B:',
            '    def run(self):',
            '        return 2',
            '',
            '',
            'x = A()',
            'x = B()',
            '',
            '',
            'def go():',
            '    return x.run()',
          ),
        ),
      );
      // x 被赋值两次，类型不确定 -> dynamic
      expect(site(r, 'mvt2.py', 'x.run')).toMatchObject({
        caller: 'mvt2.py::go',
        target: null,
        reason: 'dynamic',
      });
    });

    it('M18 跨文件：模块级变量指向导入的类 -> method 解析', async () => {
      const r = await analyze(
        sourceFile(
          'store.py',
          py(
            'class Store:',
            '    def get(self, key: str) -> str:',
            '        return key',
          ),
        ),
        sourceFile(
          'app.py',
          py(
            'from store import Store',
            '',
            '',
            's = Store()',
            '',
            '',
            'def fetch(key: str) -> str:',
            '    return s.get(key)',
          ),
        ),
      );
      // s 是 Store 的实例，Store 从 store.py 导入
      expect(site(r, 'app.py', 's.get')).toMatchObject({
        caller: 'app.py::fetch',
        target: 'store.py::Store.get',
        reason: 'resolved',
      });
      expect(edgeOf(r, 'app.py::fetch', 'store.py::Store.get')).toBeDefined();
    });﻿
    it('L1 函数内局部变量 = 构造器() -> var.method() 解析为 Class.method', async () => {
      const r = await analyze(
        sourceFile(
          'local.py',
          py(
            'class BlobSP:',
            '    def execute(self):',
            '        pass',
            '',
            '',
            'def main():',
            '    app = BlobSP()',
            '    app.execute()',
          ),
        ),
      );
      expect(site(r, 'local.py', 'app.execute')).toMatchObject({
        caller: 'local.py::main',
        target: 'local.py::BlobSP.execute',
        reason: 'resolved',
      });
      expect(edgeOf(r, 'local.py::main', 'local.py::BlobSP.execute')).toBeDefined();
    });

    it('L2 函数内局部变量被多次赋值时类型不确定，不连边', async () => {
      const r = await analyze(
        sourceFile(
          'local2.py',
          py(
            'class A:',
            '    def run(self):',
            '        return 1',
            '',
            '',
            'class B:',
            '    def run(self):',
            '        return 2',
            '',
            '',
            'def go():',
            '    x = A()',
            '    x = B()',
            '    x.run()',
          ),
        ),
      );
      expect(site(r, 'local2.py', 'x.run')).toMatchObject({
        caller: 'local2.py::go',
        target: null,
        reason: 'dynamic',
      });
    });

    it('L3 函数内 var = func() 非构造器调用 -> dynamic', async () => {
      const r = await analyze(
        sourceFile(
          'local3.py',
          py(
            'def make():',
            '    pass',
            '',
            '',
            'def go():',
            '    x = make()',
            '    x.run()',
          ),
        ),
      );
      expect(site(r, 'local3.py', 'x.run')).toMatchObject({
        caller: 'local3.py::go',
        target: null,
        reason: 'dynamic',
      });
    });

    it('L4 嵌套函数内的赋值不影响外层', async () => {
      const r = await analyze(
        sourceFile(
          'local4.py',
          py(
            'class A:',
            '    def run(self):',
            '        return 1',
            '',
            '',
            'class B:',
            '    def run(self):',
            '        return 2',
            '',
            '',
            'def outer():',
            '    x = A()',
            '    def inner():',
            '        x = B()',
            '    x.run()',
          ),
        ),
      );
      // outer 里的 x 仍然是 A 类型，inner 里的赋值不影响
      expect(site(r, 'local4.py', 'x.run')).toMatchObject({
        caller: 'local4.py::outer',
        target: 'local4.py::A.run',
        reason: 'resolved',
      });
    });


});

describeWasm('高亮：token 列范围', () => {
  const HL_SRC = py('def alpha(x):', '    # comment', '    s = "text"', '    return len(s) + x', '');

  it('关键字 / 函数名 / 注释 / 字符串 / 内置调用的列范围', async () => {
    const r = await analyze(sourceFile('hl.py', HL_SRC));
    const hl = r.highlights.get('hl.py');
    expect(hl).toBeDefined();

    const at = (line: number) => (hl ?? []).find((h) => h.line === line)?.spans ?? [];
    const has = (line: number, start: number, end: number, scope: string) =>
      at(line).some((s) => s.start === start && s.end === end && s.scope === scope);

    // def alpha(x):
    expect(has(1, 0, 3, 'keyword')).toBe(true);
    expect(has(1, 4, 9, 'funcName')).toBe(true);
    //     # comment
    expect(has(2, 4, 13, 'comment')).toBe(true);
    //     s = "text"
    expect(has(3, 8, 14, 'string')).toBe(true);
    //     return len(s) + x
    expect(has(4, 4, 10, 'keyword')).toBe(true);
    expect(has(4, 11, 14, 'funcName')).toBe(true);
    // 空行没有 span
    expect(at(5)).toEqual([]);
  });

  it('高亮覆盖每一行，且 span 不越界、不倒挂', async () => {
    const r = await analyze(sourceFile('hl.py', HL_SRC));
    const hl = r.highlights.get('hl.py') ?? [];
    const lines = r.files.find((f) => f.path === 'hl.py')?.lines ?? [];
    expect(hl).toHaveLength(lines.length);
    for (const h of hl) {
      const text = lines[h.line - 1] ?? '';
      for (const s of h.spans) {
        expect(s.start).toBeGreaterThanOrEqual(0);
        expect(s.end).toBeGreaterThan(s.start);
        expect(s.end).toBeLessThanOrEqual(text.length);
      }
    }
  });
});
