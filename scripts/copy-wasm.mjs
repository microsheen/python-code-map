#!/usr/bin/env node
/**
 * 同步 public/wasm 下的两个 .wasm，并在 Node 里跑一次真机冒烟校验。
 *
 *   核心运行时  tree-sitter.wasm        <- web-tree-sitter/web-tree-sitter.wasm
 *   Python 语法 tree-sitter-python.wasm <- @vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm
 *
 * 为什么核心运行时不用 @vscode/tree-sitter-wasm 里的那份：
 * 它由 tree-sitter-cli 0.25 编译，向宿主索要的 emscripten 胶水符号
 * （_emscripten_memcpy_js）与 web-tree-sitter 0.27 的 JS 端不一致，
 * Parser.init() 会直接 LinkError。核心 wasm 必须和 npm 里装的
 * web-tree-sitter 版本严格配套，所以从同一个包里取。
 * 语言 wasm 只导出 tree_sitter_python，靠 LANGUAGE_VERSION 兼容检查加载，
 * 用 VS Code 持续维护的预编译产物是安全的。
 *
 * 两个文件都不入库（见 .gitignore），npm install 之后由本脚本生成；
 * npm run web / npm run export 通过 preweb / preexport 自动触发。
 *
 * 用法：npm run copy-wasm [--no-verify]
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(repoRoot, 'public', 'wasm');

const CORE_NAME = 'tree-sitter.wasm';
const PYTHON_NAME = 'tree-sitter-python.wasm';
const SMOKE_SOURCE = 'def _smoke():\n    return _helper(1)\n';

/** 解析包内文件的绝对路径：优先 require.resolve（尊重 exports 字段），再退到 node_modules 直连 */
function resolveInPackage(spec, fallbackRel) {
  try {
    return require.resolve(spec);
  } catch {
    // ignore
  }
  const p = join(repoRoot, 'node_modules', fallbackRel);
  return existsSync(p) ? p : null;
}

function coreSource() {
  return resolveInPackage('web-tree-sitter/web-tree-sitter.wasm', join('web-tree-sitter', 'web-tree-sitter.wasm'));
}

function pythonSource() {
  return resolveInPackage(
    '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm',
    join('@vscode', 'tree-sitter-wasm', 'wasm', 'tree-sitter-python.wasm'),
  );
}

function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * 真跑一次 init + Language.load + parse。ABI 不配套时这里必然抛，
 * 比等到浏览器里才看到红条要早得多。
 */
async function verify(corePath, pythonPath) {
  const { Parser, Language } = await import('web-tree-sitter');
  await Parser.init({ wasmBinary: toArrayBuffer(readFileSync(corePath)) });
  const language = await Language.load(new Uint8Array(readFileSync(pythonPath)));
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(SMOKE_SOURCE);
  if (!tree || tree.rootNode.type !== 'module' || tree.rootNode.namedChildCount < 1) {
    throw new Error('parse 结果不是预期的 module 树');
  }
  tree.delete();
  parser.delete();
  return language.name || 'python';
}

function copy(src, destName, label) {
  if (!src) {
    console.error('[copy-wasm] 找不到 ' + label + '，请先执行 npm install');
    process.exitCode = 1;
    return null;
  }
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, destName);
  copyFileSync(src, dest);
  const kb = (statSync(dest).size / 1024).toFixed(1);
  console.log('[copy-wasm] ' + label + ': ' + src);
  console.log('[copy-wasm]   -> public/wasm/' + destName + '  ' + kb + ' KB');
  return dest;
}

const coreSrc = coreSource();
const pySrc = pythonSource();
const coreDest = copy(coreSrc, CORE_NAME, '核心运行时');
const pyDest = copy(pySrc, PYTHON_NAME, 'Python 语法');

if (process.exitCode || !coreDest || !pyDest) {
  process.exitCode = 1;
} else if (process.argv.includes('--no-verify')) {
  console.log('[copy-wasm] 已跳过冒烟校验（--no-verify）');
} else {
  try {
    const name = await verify(coreDest, pyDest);
    console.log('[copy-wasm] 冒烟校验通过：语言 ' + name + ' 已能被 web-tree-sitter 加载');
  } catch (e) {
    console.error('[copy-wasm] 冒烟校验失败：' + (e && e.message ? e.message : String(e)));
    console.error('[copy-wasm] 多半是 web-tree-sitter 与语言 wasm 的 ABI 不配套。');
    console.error('[copy-wasm] 请检查 package.json 里 web-tree-sitter 的版本，重新 npm install 后再跑本脚本。');
    process.exitCode = 1;
  }
}
