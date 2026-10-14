#!/usr/bin/env node
/**
 * 图标栅格化：public/icon.svg（唯一真源）-> public/ 下的 .ico / .png。
 *
 * 为什么不用 sharp / jimp：仓库承诺零运行时依赖之外的构建工具链，且 CI 的 checks job 不装
 * 浏览器以外的图像库；headless Chrome 是 browser-verify.mjs 已经在用的那台"真渲染器"，
 * 用它栅格化等于"图标在浏览器里长什么样，产物就是什么样"，不引入第二套 SVG 解释器。
 *
 * 产物（全部入库，导出时原样拷进 dist/，文件名不带 hash => 缓存策略按"无 hash"一档处理）：
 *   favicon.ico          16/32/48 三档，PNG-in-ICO（Vista+ 容器，现代浏览器全支持）
 *   apple-touch-icon.png 180x180（iOS 主屏）
 *   icon-192.png         192x192（manifest / 通用）
 *   icon-512.png         512x512（manifest / og 兜底）
 *
 * 用法：npm run icons
 * 改完 public/icon.svg 必须重跑本脚本并提交产物：PNG/ICO 是派生物，但入库是为了让
 * `npm run export` 与 CI 的 checks job 不需要 Chrome 也能产出完整 dist/。
 *
 * 幂等性：同一份 icon.svg + 同一台 Chrome 版本 => 逐字节相同（PNG 编码无时间戳）。
 * 换 Chrome 大版本可能改变抗锯齿像素，属预期；以当次 stdout 的 sha256 为准。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'icon.svg');
const OUT = {
  ico: path.join(ROOT, 'public', 'favicon.ico'),
  180: path.join(ROOT, 'public', 'apple-touch-icon.png'),
  192: path.join(ROOT, 'public', 'icon-192.png'),
  512: path.join(ROOT, 'public', 'icon-512.png'),
};
const ICO_SIZES = [16, 32, 48];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
    : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Chromium 可执行文件，用 CHROME_PATH 环境变量指定一个');
}

function fail(msg) {
  console.error('[build-icons] ' + msg);
  process.exit(1);
}

/** Chrome 在 Windows 上退出后仍会短暂握着刚写出的截图句柄：EBUSY/EPERM 重试 */
function readWithRetry(file, tries = 40) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return fs.readFileSync(file);
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      sleepMs(100);
    }
  }
  throw lastErr;
}

/** PNG 的 IHDR：宽/高/位深/颜色类型。只读头部，不 inflate。 */
function pngInfo(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a)
    return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

/**
 * 8-bit RGBA PNG 的像素解码（inflate + 五种行滤波反算）。只为"圆角外必须透明、中心必须不透明"
 * 这条不变式服务：颜色类型不对就直接抛，不做通用 PNG 库。
 */
function pngPixels(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let bd = 0;
  let ct = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || ct !== 6)
    throw new Error('pngPixels 只支持 8-bit RGBA，实际 bitDepth=' + bd + ' colorType=' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= 4 ? out[row + x - 4] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= 4 && y > 0 ? out[prev + x - 4] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('未知 PNG 行滤波 ' + filter);
      out[row + x] = v & 0xff;
    }
    rp += stride;
  }
  return { w, h, data: out };
}

/** 不变式：圆角外 alpha=0（否则磁贴/Dock 露白角），中心 alpha=255（否则图标是空的） */
function assertAlphaShape(buf, label) {
  const px = pngPixels(buf);
  const alpha = (x, y) => px.data[(y * px.w + x) * 4 + 3];
  const mid = Math.floor(px.w / 2);
  if (alpha(0, 0) !== 0)
    fail(label + ' 左上角不透明（alpha=' + alpha(0, 0) + '），栅格化时背景没设成透明');
  if (alpha(mid, mid) !== 255)
    fail(label + ' 中心不不透明（alpha=' + alpha(mid, mid) + '），图标本体被画空了');
}

function rasterize(chrome, svgText, size, outPath, workdir) {
  // viewBox 不变，只改固有尺寸：矢量缩放，抗锯齿交给真浏览器。
  // 替换串必须用函数：'$1' + 512 + '$2' 会拼成 "$1512$2"，$15 被当成第 15 组的回退写法，
  // 512 这一档会把字符串替换成它自己（[实测] 第一版就是这么静默失败的）。
  let hits = 0;
  const bump = (a, b) => {
    hits++;
    return a + size + b;
  };
  const sized = svgText
    .replace(/(<svg[^>]*\swidth=")\d+(")/, (m, a, b) => bump(a, b))
    .replace(/(<svg[^>]*\sheight=")\d+(")/, (m, a, b) => bump(a, b));
  // 不能比字符串是否变化：512 档把 width="512" 替换成它自己，字符串不变但替换确实发生了
  if (hits !== 2) fail('public/icon.svg 的 <svg> 标签上找不到 width/height 属性，无法按尺寸栅格化');
  const svgPath = path.join(workdir, 'icon-' + size + '.svg');
  fs.writeFileSync(svgPath, sized, 'utf8');
  if (fs.existsSync(outPath)) fs.rmSync(outPath);
  const r = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // 透明背景：圆角外面必须是 alpha=0，否则 Windows 磁贴 / macOS Dock 上会露白角
      '--default-background-color=00000000',
      '--user-data-dir=' + path.join(workdir, 'profile-' + size),
      '--window-size=' + size + ',' + size,
      '--screenshot=' + outPath,
      'file:///' + svgPath.split(path.sep).join('/'),
    ],
    { encoding: 'utf8', timeout: 60000 }
  );
  // [实测] Chrome 155 上 --screenshot 偶尔在进程退出后才落盘：轮询 3s 再判死
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(outPath) && Date.now() < deadline) sleepMs(100);
  if (!fs.existsSync(outPath))
    fail(
      'Chrome 没有产出 ' +
        outPath +
        '（exit=' +
        r.status +
        ' stderr=' +
        String(r.stderr).slice(0, 400) +
        '）'
    );
  const info = pngInfo(readWithRetry(outPath));
  if (!info || info.width !== size || info.height !== size) {
    fail(
      outPath +
        ' 尺寸不对：期望 ' +
        size +
        'x' +
        size +
        '，实际 ' +
        (info ? info.width + 'x' + info.height : '不是 PNG')
    );
  }
  return info;
}

/** ICO 容器：PNG-in-ICO（每个 entry 的 payload 就是一段完整 PNG） */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = [];
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

/** 同步睡：不引依赖，也不起子进程 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

if (!fs.existsSync(SRC)) fail('缺少母版 ' + SRC);
const svgText = fs.readFileSync(SRC, 'utf8');
const chrome = findChrome();
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-icons-'));

try {
  const pngs = [];
  for (const size of ICO_SIZES) {
    rasterize(chrome, svgText, size, path.join(workdir, 'ico-' + size + '.png'), workdir);
    pngs.push({ size, buf: readWithRetry(path.join(workdir, 'ico-' + size + '.png')) });
  }
  const ico = buildIco(pngs);
  fs.writeFileSync(OUT.ico, ico);

  for (const size of [180, 192, 512]) {
    rasterize(chrome, svgText, size, OUT[size], workdir);
  }

  // ---- 自检：入库产物必须自报家门 ----
  const icoBuf = readWithRetry(OUT.ico);
  if (icoBuf.readUInt16LE(0) !== 0 || icoBuf.readUInt16LE(2) !== 1) fail('favicon.ico 头不对');
  const count = icoBuf.readUInt16LE(4);
  if (count !== ICO_SIZES.length) fail('favicon.ico entry 数 ' + count + ' != ' + ICO_SIZES.length);
  for (let i = 0; i < count; i++) {
    const off = 6 + 16 * i;
    const w = icoBuf[off] === 0 ? 256 : icoBuf[off];
    const h = icoBuf[off + 1] === 0 ? 256 : icoBuf[off + 1];
    const len = icoBuf.readUInt32LE(off + 8);
    const pos = icoBuf.readUInt32LE(off + 12);
    const inner = pngInfo(icoBuf.subarray(pos, pos + len));
    if (!inner || inner.width !== w || inner.height !== h)
      fail('favicon.ico 第 ' + i + ' 档 payload 不是 ' + w + 'x' + h + ' 的 PNG');
  }
  for (const size of [180, 192, 512]) {
    const buf = readWithRetry(OUT[size]);
    const info = pngInfo(buf);
    if (
      !info ||
      info.width !== size ||
      info.height !== size ||
      info.bitDepth !== 8 ||
      info.colorType !== 6
    ) {
      fail(OUT[size] + ' 不是 8-bit RGBA ' + size + 'x' + size + ' PNG');
    }
    assertAlphaShape(buf, path.basename(OUT[size]));
  }
  assertAlphaShape(pngs[pngs.length - 1].buf, 'favicon.ico@48');

  console.log('[build-icons] Chrome: ' + chrome);
  for (const f of [OUT.ico, OUT[180], OUT[192], OUT[512]]) {
    const buf = readWithRetry(f);
    console.log(
      '[build-icons] ' +
        path.relative(ROOT, f).split(path.sep).join('/') +
        '  ' +
        buf.length +
        'B  sha256=' +
        sha(buf).slice(0, 16) +
        '…'
    );
  }
  console.log(
    '[build-icons] OK：favicon.ico(' +
      ICO_SIZES.join('/') +
      ') + 180/192/512 PNG 均已按母版重生成并通过自检'
  );
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
