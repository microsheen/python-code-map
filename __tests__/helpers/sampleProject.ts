/**
 * 一个不依赖 wasm 的两文件样例工程，供组件测试预置 store。
 *
 * a.py
 *   alpha -> beta            （同文件直调）
 *   beta  -> print           （external，用来验证节点角标）
 *   use_gamma -> b.gamma     （跨文件 mod.func()）
 * b.py
 *   gamma -> alpha           （from a import alpha 后直调，形成跨文件环）
 */
import { analysisOf, callSite, func, graphFromAnalyses, pyFile, span, tokens } from './synth';
import type {
  CallGraph,
  FileAnalysis,
  FuncId,
  LineTokens,
  PyFile,
} from '../../src/parser/types';
import { makeFuncId } from '../../src/parser/symbols';

export const A_PATH = 'a.py';
export const B_PATH = 'b.py';

export const A_SRC = [
  'import b',
  '',
  'def alpha():',
  '    return beta()',
  '',
  'def beta():',
  '    print(1)',
  '',
  'def use_gamma():',
  '    return b.gamma()',
  '',
].join('\n');

export const B_SRC = [
  'from a import alpha',
  '',
  'def gamma():',
  '    alpha()',
  '    return 2',
  '',
].join('\n');

export const ID_ALPHA: FuncId = makeFuncId(A_PATH, 'alpha');
export const ID_BETA: FuncId = makeFuncId(A_PATH, 'beta');
export const ID_USE_GAMMA: FuncId = makeFuncId(A_PATH, 'use_gamma');
export const ID_GAMMA: FuncId = makeFuncId(B_PATH, 'gamma');

function aHighlights(): LineTokens[] {
  return [
    tokens(1, [span(0, 6, 'keyword'), span(7, 8, 'identifier')]),
    tokens(3, [span(0, 3, 'keyword'), span(4, 9, 'funcName')]),
    tokens(4, [span(4, 10, 'keyword'), span(11, 15, 'funcName')]),
    tokens(6, [span(0, 3, 'keyword'), span(4, 8, 'funcName')]),
    tokens(7, [span(4, 9, 'builtin'), span(9, 10, 'plain'), span(10, 11, 'number')]),
    tokens(9, [span(0, 3, 'keyword'), span(4, 13, 'funcName')]),
    tokens(10, [span(4, 10, 'keyword'), span(11, 18, 'funcName')]),
  ];
}

function bHighlights(): LineTokens[] {
  return [
    tokens(1, [
      span(0, 4, 'keyword'),
      span(5, 6, 'identifier'),
      span(7, 13, 'keyword'),
      span(14, 19, 'identifier'),
    ]),
    tokens(3, [span(0, 3, 'keyword'), span(4, 9, 'funcName')]),
    tokens(4, [span(4, 9, 'funcName')]),
    tokens(5, [span(4, 10, 'keyword'), span(11, 12, 'number')]),
  ];
}

export interface SampleProject {
  files: PyFile[];
  analyses: FileAnalysis[];
  highlights: Map<string, LineTokens[]>;
  graph: CallGraph;
}

export function sampleProject(): SampleProject {
  const aFile = pyFile(A_PATH, A_SRC);
  const bFile = pyFile(B_PATH, B_SRC);

  const aFuncs = [
    func(A_PATH, 'alpha', { defLine: 3, startLine: 3, endLine: 4 }),
    func(A_PATH, 'beta', { defLine: 6, startLine: 6, endLine: 7 }),
    func(A_PATH, 'use_gamma', { defLine: 9, startLine: 9, endLine: 10 }),
  ];
  const bFuncs = [func(B_PATH, 'gamma', { defLine: 3, startLine: 3, endLine: 5 })];

  const aCalls = [
    callSite({
      file: A_PATH,
      line: 4,
      column: 11,
      text: 'beta',
      caller: ID_ALPHA,
      target: ID_BETA,
    }),
    callSite({
      file: A_PATH,
      line: 7,
      column: 4,
      text: 'print',
      caller: ID_BETA,
      reason: 'external',
    }),
    callSite({
      file: A_PATH,
      line: 10,
      column: 11,
      text: 'b.gamma',
      caller: ID_USE_GAMMA,
      target: ID_GAMMA,
    }),
  ];
  const bCalls = [
    callSite({
      file: B_PATH,
      line: 4,
      column: 4,
      text: 'alpha',
      caller: ID_GAMMA,
      target: ID_ALPHA,
    }),
  ];

  const analyses = [analysisOf(aFile, aFuncs, aCalls), analysisOf(bFile, bFuncs, bCalls)];
  const highlights = new Map<string, LineTokens[]>();
  highlights.set(A_PATH, aHighlights());
  highlights.set(B_PATH, bHighlights());

  return {
    files: [aFile, bFile],
    analyses,
    highlights,
    graph: graphFromAnalyses(analyses, 12),
  };
}

/**
 * 单文件大工程：每个函数占 3 行，用来验证代码区的窗口化渲染。
 * count = 1400 时共 4200 行。
 */
export function bigProject(count: number, path = 'big.py'): SampleProject {
  const lines: string[] = [];
  const funcs = [];
  const calls = [];
  for (let i = 0; i < count; i++) {
    const name = 'f' + String(i);
    const defLine = i * 3 + 1;
    lines.push('def ' + name + '():');
    lines.push('    return ' + String(i));
    lines.push('');
    funcs.push(
      func(path, name, { defLine, startLine: defLine, endLine: defLine + 1 }),
    );
    if (i > 0) {
      calls.push(
        callSite({
          file: path,
          line: defLine,
          column: 11,
          text: 'f' + String(i - 1),
          caller: makeFuncId(path, name),
          target: makeFuncId(path, 'f' + String(i - 1)),
        }),
      );
    }
  }
  const file = pyFile(path, lines.join('\n'));
  const analyses = [analysisOf(file, funcs, calls)];
  return {
    files: [file],
    analyses,
    highlights: new Map<string, LineTokens[]>(),
    graph: graphFromAnalyses(analyses, 5),
  };
}
