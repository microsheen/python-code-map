/**
 * 测试用的 tree-sitter 解析器：直接从 public/wasm 读字节，绕开浏览器 fetch。
 *
 * 这两个 .wasm 不入库（见 .gitignore），由 npm run copy-wasm 从
 * @vscode/tree-sitter-wasm 同步。缺失时相关测试整体跳过而不是失败，
 * 这样"没跑过 copy-wasm 的新克隆"也能先把纯函数测试跑完。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPythonParser } from '../../src/parser/treeSitter';
import type { PythonParser } from '../../src/parser/treeSitter';
import type { SyntaxNodeLike } from '../../src/parser/treeLike';
import { makePyFile } from '../../src/parser/analyze';
import type { PyFile } from '../../src/parser/types';

const WASM_DIR = join(__dirname, '..', '..', 'public', 'wasm');
const CORE = join(WASM_DIR, 'tree-sitter.wasm');
const PYTHON = join(WASM_DIR, 'tree-sitter-python.wasm');

export function hasWasm(): boolean {
  return existsSync(CORE) && existsSync(PYTHON);
}

/** wasm 缺失时跳过整个 describe，并说明怎么补。 */
export const describeWasm = hasWasm() ? describe : describe.skip;

if (!hasWasm()) {
  console.warn('[tests] 未找到 public/wasm/*.wasm，解析类测试已跳过。请先执行 npm run copy-wasm');
}

let cached: Promise<PythonParser> | null = null;

/** 全测试共享一个 parser（创建成本高，且 web-tree-sitter 的 init 是全局单例）。 */
export function getTestParser(): Promise<PythonParser> {
  if (!cached) {
    cached = createPythonParser({
      coreBinary: new Uint8Array(readFileSync(CORE)),
      pythonBinary: new Uint8Array(readFileSync(PYTHON)),
    });
  }
  return cached;
}

export async function parseSource(source: string): Promise<SyntaxNodeLike> {
  const parser = await getTestParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter 返回空树');
  return tree.rootNode;
}

/** 读 fixtures/*.py；路径默认只用文件名，贴近"用户上传零散文件"的场景。 */
export function fixtureFile(name: string, dirName = 'fixtures'): PyFile {
  const full = join(__dirname, '..', '..', dirName, name);
  const content = readFileSync(full, 'utf8');
  return makePyFile(name, name, content);
}

export function sourceFile(name: string, content: string): PyFile {
  return makePyFile(name, name, content);
}
