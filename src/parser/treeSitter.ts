/**
 * web-tree-sitter 单例封装。
 *
 * 设计要点：
 * - 核心 wasm 与语言 wasm 都优先用 fetch 拿字节再交给 emscripten，
 *   绕开静态托管环境下 .wasm 的 MIME / 路径问题。
 * - 创建时做一次冒烟校验（parse 一小段代码），失败直接抛错，绝不静默降级。
 * - 只暴露 SyntaxNodeLike，业务层不感知 web-tree-sitter 的类型。
 */
import { Language, Parser } from 'web-tree-sitter';
import type { SyntaxNodeLike } from './treeLike';

export interface ParseTree {
  readonly rootNode: SyntaxNodeLike;
  delete(): void;
}

export interface PythonParser {
  parse(text: string): ParseTree | null;
  dispose(): void;
}

export interface WasmSource {
  /** 核心 runtime wasm 的 URL（浏览器环境） */
  coreUrl?: string;
  /** 直接给字节（Node / 测试环境） */
  coreBinary?: Uint8Array;
  pythonUrl?: string;
  pythonBinary?: Uint8Array;
}

export const CORE_WASM_FILE = 'tree-sitter.wasm';
export const PYTHON_WASM_FILE = 'tree-sitter-python.wasm';

type InitOptions = Parameters<typeof Parser.init>[0];

let initPromise: Promise<void> | null = null;

async function initRuntime(source: WasmSource): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (source.coreBinary) {
      const buf = toArrayBuffer(source.coreBinary);
      const opts: Record<string, unknown> = { wasmBinary: buf };
      await Parser.init(opts as unknown as InitOptions);
      return;
    }
    if (source.coreUrl) {
      const bytes = await fetchFirst(wasmCandidates(source.coreUrl));
      const opts: Record<string, unknown> = { wasmBinary: toArrayBuffer(bytes) };
      await Parser.init(opts as unknown as InitOptions);
      return;
    }
    const opts: Record<string, unknown> = {
      locateFile: (file: string) => `/wasm/${file}`,
    };
    await Parser.init(opts as unknown as InitOptions);
  })();
  return initPromise;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function wasmCandidates(file: string): string[] {
  const rel = file.replace(/^\/+/, '');
  const out: string[] = [];
  if (typeof document !== 'undefined' && document.baseURI) {
    try {
      out.push(new URL(`wasm/${rel}`, document.baseURI).href);
    } catch {
      // ignore
    }
  }
  out.push(`/wasm/${rel}`, `wasm/${rel}`);
  return [...new Set(out)];
}

async function fetchFirst(urls: string[]): Promise<Uint8Array> {
  let lastError = '';
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (!res.ok) {
        lastError = `${u} -> HTTP ${res.status}`;
        continue;
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      lastError = `${u} -> ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`加载 WASM 失败：${lastError || urls.join(', ')}`);
}

const SMOKE_SOURCE = 'def _smoke():\n    return _helper(1)\n';

export async function createPythonParser(source: WasmSource = {}): Promise<PythonParser> {
  await initRuntime(source);
  const bytes = source.pythonBinary
    ? source.pythonBinary
    : await fetchFirst(wasmCandidates(source.pythonUrl ?? PYTHON_WASM_FILE));
  const language = await Language.load(bytes);
  const parser = new Parser();
  parser.setLanguage(language);

  // 冒烟校验：ABI 不匹配时这里会抛，避免后面拿到的树是错的却没人知道
  const smoke = parser.parse(SMOKE_SOURCE);
  if (!smoke || smoke.rootNode.type !== 'module' || smoke.rootNode.namedChildCount < 1) {
    throw new Error(
      'tree-sitter-python 冒烟校验失败：语法 wasm 与 web-tree-sitter 运行时 ABI 不兼容。' +
        '请执行 npm run copy-wasm 重新同步 public/wasm 下的两个 .wasm 文件。',
    );
  }
  smoke.delete();

  return {
    parse(text: string): ParseTree | null {
      const tree = parser.parse(text);
      if (!tree) return null;
      return tree as unknown as ParseTree;
    },
    dispose(): void {
      try {
        parser.delete();
      } catch {
        // ignore
      }
      const free = (language as unknown as { delete?: () => void }).delete;
      if (typeof free === "function") {
        try {
          free.call(language);
        } catch {
          // ignore
        }
      }
    },
  };
}

let singleton: Promise<PythonParser> | null = null;

/** 浏览器端使用的单例（懒加载）。 */
export function getParser(): Promise<PythonParser> {
  if (!singleton) {
    singleton = createPythonParser({
      coreUrl: CORE_WASM_FILE,
      pythonUrl: PYTHON_WASM_FILE,
    });
    singleton.catch(() => {
      singleton = null; // 失败后允许重试
    });
  }
  return singleton;
}

export function resetParser(): void {
  if (singleton) {
    singleton.then((p) => p.dispose()).catch(() => undefined);
  }
  singleton = null;
  initPromise = null;
}