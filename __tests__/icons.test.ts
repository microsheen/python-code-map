/**
 * 站点图标链路的结构不变量。
 *
 * 全部读仓库真源（public/ 与 scripts/），不依赖 dist/，覆盖四件事：
 *  1. public/icon.svg 是唯一真源：512 画布、零绝对 URL、配色只能来自 src/theme.ts；
 *  2. 派生物自报家门：favicon.ico 的三档 payload 是尺寸匹配的 PNG，三个 PNG 是 8-bit RGBA
 *     且"圆角外透明、中心不透明"（Chrome 栅格化时背景色没漏进来）；
 *  3. scripts/inject-html-head.mjs 的注入清单：href 全部同源相对、文件真在 public/ 里，
 *     theme-color 与 theme.ts 的 bg 同源；
 *  4. public/_headers 的缓存档位：图标走"无 hash"一档（max-age=0），且不会被任何
 *     immutable 通配命中（否则换了图标用户还看旧的）。
 *
 * PNG 解码只够这条不变量用，与 scripts/build-icons.mjs 的 pngPixels 同构，不做通用库。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const pub = (rel: string) => path.join(PUB, rel);
const readPub = (rel: string) => fs.readFileSync(pub(rel));

const ICON_FILES = [
  'icon.svg',
  'favicon.ico',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
];

/** 三个独立 PNG 派生物：尺寸与 alpha 形状共用同一组用例 */
const PNG_CASES: [string, number][] = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];

/** 与 scripts/browser-verify.mjs 的 globToRe 同构：* 任意串、? 单字符 */
function globToRe(pattern: string): RegExp {
  let out = '';
  for (const c of pattern) {
    if (c === '*') out += '.*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[{}()|^$.[\]\\+]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

interface Png {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  px: Buffer;
}

/** 8-bit RGBA PNG 的 IHDR + 像素（inflate + 五种行滤波反算） */
function decodePng(buf: Buffer): Png {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a)
    throw new Error('不是 PNG 签名');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6)
    throw new Error(`只支持 8-bit RGBA，实际 bitDepth=${bitDepth} colorType=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++] ?? 0;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x] ?? 0;
      const a = x >= 4 ? (px[row + x - 4] ?? 0) : 0;
      const b = y > 0 ? (px[prev + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (px[prev + x - 4] ?? 0) : 0;
      let v: number;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('未知行滤波 ' + filter);
      px[row + x] = v & 0xff;
    }
    rp += stride;
  }
  return { width, height, bitDepth, colorType, px };
}

const alphaAt = (p: Png, x: number, y: number) => p.px[(y * p.width + x) * 4 + 3] ?? 0;

/** ICO 容器：type=1，每个 entry 的 payload 是一段完整 PNG */
function icoEntries(buf: Buffer) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1)
    throw new Error('ICO 头不对（reserved/type）');
  const count = buf.readUInt16LE(4);
  const out: { w: number; h: number; len: number; pos: number }[] = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + 16 * i;
    out.push({
      w: buf[off] === 0 ? 256 : (buf[off] ?? 0),
      h: buf[off + 1] === 0 ? 256 : (buf[off + 1] ?? 0),
      len: buf.readUInt32LE(off + 8),
      pos: buf.readUInt32LE(off + 12),
    });
  }
  return out;
}

/** _headers 的规则表：与 scripts/browser-verify.mjs 的 loadHeaderRules 同构 */
function headerRules(text: string) {
  const rules: { pattern: string; headers: [string, string][] }[] = [];
  let cur: { pattern: string; headers: [string, string][] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      cur = { pattern: line.trim(), headers: [] };
      rules.push(cur);
      continue;
    }
    const m = line.trim().match(/^([^:]+):\s*(.+)$/);
    const key = m?.[1]?.trim();
    const val = m?.[2]?.trim();
    if (key && val && cur) cur.headers.push([key, val]);
  }
  return rules;
}

describe('public/icon.svg（唯一真源）', () => {
  const svg = readPub('icon.svg').toString('utf8');

  it('512 画布：width/height/viewBox 三处一致', () => {
    expect(svg).toContain('width="512"');
    expect(svg).toContain('height="512"');
    expect(svg).toContain('viewBox="0 0 512 512"');
  });

  it('零绝对 URL：http 只出现一次（xmlns），且没有 xlink', () => {
    expect(svg.match(/https?:\/\//g)).toEqual(['http://']);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain('xlink');
  });

  it('配色全部来自 src/theme.ts：图标与界面同源', () => {
    const theme = fs.readFileSync(path.join(ROOT, 'src', 'theme.ts'), 'utf8');
    const themeHex = new Set((theme.match(/#[0-9a-f]{6}/gi) ?? []).map((h) => h.toLowerCase()));
    const iconHex = [...new Set((svg.match(/#[0-9a-f]{6}/gi) ?? []).map((h) => h.toLowerCase()))];
    expect(iconHex.filter((h) => !themeHex.has(h))).toEqual([]);
    // 笔画 = 主题强调色、底板 = 主题纸面色：图标与界面同源，换主题色时图标跟着换
    const accentDim = theme.match(/accentDim: '(#[0-9a-f]{6})'/i)?.[1];
    const paper = theme.match(/paper: '(#[0-9a-f]{6})'/i)?.[1];
    expect(accentDim).toBeDefined();
    expect(paper).toBeDefined();
    expect(iconHex).toContain(accentDim);
    expect(iconHex).toContain(paper);
  });
});

describe('派生栅格物', () => {
  it.each(ICON_FILES)('%s 存在且非空', (name) => {
    expect(fs.statSync(pub(name)).size).toBeGreaterThan(0);
  });

  it('favicon.ico：三档 16/32/48，payload 是尺寸匹配的 PNG', () => {
    const buf = readPub('favicon.ico');
    const entries = icoEntries(buf);
    expect(entries.map((e) => e.w)).toEqual([16, 32, 48]);
    expect(entries.map((e) => e.h)).toEqual([16, 32, 48]);
    for (const e of entries) {
      const payload = buf.subarray(e.pos, e.pos + e.len);
      const png = decodePng(payload);
      expect(png.width).toBe(e.w);
      expect(png.height).toBe(e.h);
    }
    // entry 首尾相接铺满整个文件：没有悬空字节
    const last = entries[entries.length - 1];
    if (!last) throw new Error('ICO 一个 entry 都没有');
    expect(last.pos + last.len).toBe(buf.length);
  });

  it.each(PNG_CASES)('%s 是 8-bit RGBA %ix%i', (name, size) => {
    const png = decodePng(readPub(name));
    expect([png.width, png.height]).toEqual([size, size]);
    expect([png.bitDepth, png.colorType]).toEqual([8, 6]);
  });

  it.each(PNG_CASES)('%s 圆角外透明、中心不透明', (name, size) => {
    const png = decodePng(readPub(name));
    expect(alphaAt(png, 0, 0)).toBe(0);
    expect(alphaAt(png, size - 1, size - 1)).toBe(0);
    expect(alphaAt(png, size >> 1, size >> 1)).toBe(255);
  });
});

describe('scripts/inject-html-head.mjs 的注入清单', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'inject-html-head.mjs'), 'utf8');
  const linksBlock = src.slice(
    src.indexOf('export const HEAD_LINKS = ['),
    src.indexOf('];', src.indexOf('export const HEAD_LINKS = ['))
  );
  const hrefs = [...linksBlock.matchAll(/href: '([^']+)'/g)]
    .map((m) => m[1])
    .filter((h): h is string => typeof h === 'string');
  const rels = [...linksBlock.matchAll(/rel: '([^']+)'/g)]
    .map((m) => m[1])
    .filter((r): r is string => typeof r === 'string');

  it('四个 link：svg 主档 + ico 兜底 + 192 + apple-touch', () => {
    expect(hrefs).toEqual(['/icon.svg', '/favicon.ico', '/icon-192.png', '/apple-touch-icon.png']);
    expect(rels).toEqual(['icon', 'alternate icon', 'icon', 'apple-touch-icon']);
  });

  it('href 全部同源相对，且文件真在 public/ 里', () => {
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(href.startsWith('/')).toBe(true);
      expect(fs.existsSync(pub(href.slice(1)))).toBe(true);
    }
  });

  it('theme-color 与 theme.ts 的 bg 同源', () => {
    const theme = fs.readFileSync(path.join(ROOT, 'src', 'theme.ts'), 'utf8');
    const bg = theme.match(/bg: '(#[0-9a-f]{6})'/i)?.[1];
    const meta = src.match(/name: 'theme-color', content: '([^']+)'/)?.[1];
    expect(bg).toBeDefined();
    expect(meta).toBe(bg);
  });

  it('幂等哨兵在场：同一份 dist 重复注入不会叠标签', () => {
    expect(src).toContain('data-codemap="icon"');
  });
});

describe('public/_headers 的缓存档位', () => {
  const rules = headerRules(readPub('_headers').toString('utf8'));
  const matched = (pathname: string) => rules.filter((r) => globToRe(r.pattern).test(pathname));
  const cacheOf = (pathname: string) =>
    matched(pathname)
      .flatMap((r) => r.headers)
      .filter(([k]) => k.toLowerCase() === 'cache-control')
      .map(([, v]) => v);

  it.each(ICON_FILES)('%s 走无 hash 一档：max-age=0 且不被 immutable 命中', (name) => {
    const values = cacheOf('/' + name);
    expect(values).toContain('public, max-age=0, must-revalidate');
    expect(values.some((v) => v.includes('immutable'))).toBe(false);
  });

  it('带 hash 的资产仍是 immutable（图标规则没有误伤）', () => {
    expect(cacheOf('/_expo/static/js/web/entry-abc.js')).toEqual([
      'public, max-age=31536000, immutable',
    ]);
    expect(cacheOf('/assets/some-thing.webmanifest')).toEqual([
      'public, max-age=31536000, immutable',
    ]);
  });

  it('wasm 仍是无 hash 一档（旧 wasm + 新 JS = LinkError）', () => {
    expect(cacheOf('/wasm/tree-sitter-python.wasm')).toContain(
      'public, max-age=0, must-revalidate'
    );
  });
});

describe('package.json 的脚本链', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('icons 脚本指向 build-icons.mjs', () => {
    expect(pkg.scripts.icons).toBe('node scripts/build-icons.mjs');
  });

  it('postexport 先注入 <head> 再跑 polish：注入的 href 也在门禁覆盖内', () => {
    expect(pkg.scripts.postexport).toBe(
      'node scripts/inject-html-head.mjs && node scripts/polish-dist.mjs'
    );
  });
});
