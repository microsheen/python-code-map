/**
 * 真浏览器验收脚本：headless Chrome + 原生 CDP，不依赖 playwright。
 *
 * 为什么需要它：jest + jsdom 测不出"闪烁高亮在真实 rAF 下的淡出""SVG 节点能否被真实
 * 鼠标点中"这类问题（见 ADR 与提交 d0f0832 的修复说明）。这里把 README 手动验收清单里
 * 的双向定位核心项自动化：上传 fixtures -> 点图节点 -> 断言左侧切文件/滚动/高亮带/闪烁，
 * 再反向点代码 -> 断言图居中/描边/不闪烁。
 *
 * 用法：
 *   npm run export                 # 先产出 dist/
 *   node scripts/browser-verify.mjs
 * 可选环境变量：CODEMAP_PORT（静态服务端口，默认 8099，被占用则复用已有服务）、
 * CODEMAP_CDP_PORT（Chrome 调试端口，默认 9333）、CHROME_PATH（浏览器可执行文件）。
 * 截图与 JSON 报告写到系统临时目录（codemap-shots / codemap-verify-report.json）。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const APP_PORT = Number(process.env.CODEMAP_PORT || 8099);
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
let PORT = Number(process.env.CODEMAP_CDP_PORT || 9333);
const TMP = os.tmpdir();
let PROFILE = path.join(TMP, 'cdp-codemap-profile');
const SHOTS = path.join(TMP, 'codemap-shots');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到 Chrome/Chromium 可执行文件，用 CHROME_PATH 环境变量指定一个');
}

const CHROME = findChrome();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * dist/ 路径解析：唯一一处。静态服务器与"每个被请求的资产都必须真实存在于 dist/"这条断言
 * 共用它 —— 也就是说服务器根本没有能力端出 dist/ 以外的东西。
 */
function distFileFor(pathname) {
  const decoded = decodeURIComponent(pathname);
  const p = decoded.endsWith('/') ? decoded + 'index.html' : decoded;
  const file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

/** _headers 的 glob -> 锚定正则：* 任意串、? 单字符、:name 单个路径段 */
function globToRe(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '[^/]';
    else if (c === ':') {
      const j = pattern.indexOf('/', i);
      const end = j < 0 ? pattern.length : j;
      out += '[^/]+';
      i = end - 1;
    } else out += c.replace(/[{}()|^$.\[\]\\+]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/**
 * 读 dist/_headers 并在本地静态服务上原样生效：冒烟必须跑在真正会上线的 CSP / 缓存策略下，
 * 否则"本地全绿、线上红"是结构性的。pathname 与解析后的 dist 相对路径任一命中都算（取并集），
 * 也就是本地比线上更严 —— 只会多拦，不会漏拦。
 */
function loadHeaderRules() {
  const file = path.join(DIST, '_headers');
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      cur = { pattern: line.trim(), headers: [] };
      rules.push(cur);
      continue;
    }
    if (cur) {
      const m = line.trim().match(/^([^:]+):\s*(.+)$/);
      if (m) cur.headers.push([m[1].trim(), m[2].trim()]);
    }
  }
  for (const r of rules) r.re = globToRe(r.pattern);
  return rules;
}

const HEADER_RULES = loadHeaderRules();

/** 后命中的规则覆盖同名头；同时返回命中的 pattern，供报告核对 */
function headersFor(pathname, relFile) {
  const headers = {};
  const matched = [];
  for (const r of HEADER_RULES) {
    if (r.re.test(pathname) || (relFile && r.re.test(relFile))) {
      for (const kv of r.headers) headers[kv[0].toLowerCase()] = kv[1];
      matched.push(r.pattern);
    }
  }
  return { headers, matched };
}

/** 托管 dist/（含 _headers 规则）；端口被占用时假定已有服务在跑，直接复用。 */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = distFileFor(pathname);
      if (!file) {
        // Chrome 会自己去要 /favicon.ico，dist 里没有；回 204 免得污染控制台错误列表
        if (decodeURIComponent(pathname) === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const rel = '/' + path.relative(DIST, file).split(path.sep).join('/');
      const rule = headersFor(decodeURIComponent(pathname), rel);
      const out = {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      };
      for (const k of Object.keys(rule.headers)) out[k] = rule.headers[k];
      res.writeHead(200, out);
      res.end(fs.readFileSync(file));
    });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        resolve({ server: null, reused: true });
        return;
      }
      reject(e);
    });
    server.listen(APP_PORT, '127.0.0.1', () => resolve({ server, reused: false }));
  });
}

const ENTRY_SCRIPT_RE = /<script[^>]+src="([^"]*\/_expo\/static\/js\/web\/entry-[0-9a-f]+\.js)"[^>]*>/;
const ABS_URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** dist/index.html 应该是谁：入口脚本 + 整文件 sha256（被测字节 == 上线字节的锚点） */
function distIndex() {
  const buf = fs.readFileSync(path.join(DIST, 'index.html'));
  const m = buf.toString('utf8').match(ENTRY_SCRIPT_RE);
  return { bytes: buf.length, entry: m ? m[1] : null, sha256: sha256(buf) };
}

/**
 * 复用别人的端口有风险，必须先确认这个端口上跑的确实是"当前 dist/ 的那个应用"。
 * 判据不能用 <title>：标题来自 app.json，文案一改就会误判（历史上真的这么红过）。
 * 用"HTML 里带着本项目 Metro 入口脚本标签"作身份判据，顺带把 sha256 与响应头取回来。
 */
async function probeAppUrl() {
  let res;
  try {
    res = await fetch(APP_URL, { cache: 'no-store' });
  } catch (e) {
    throw new Error('访问 ' + APP_URL + ' 失败：' + e.message + '（端口 ' + APP_PORT + ' 上没有可用服务）');
  }
  if (!res.ok) throw new Error(APP_URL + ' 返回 HTTP ' + res.status);
  const text = await res.text();
  const buf = Buffer.from(text, 'utf8');
  const m = text.match(ENTRY_SCRIPT_RE);
  if (!m) {
    throw new Error(
      APP_URL + ' 返回的 HTML 里没有本应用的 Metro 入口脚本标签：端口 ' + APP_PORT +
        ' 上可能不是这个服务，或者它是旧产物。用 CODEMAP_PORT 换个端口再跑',
    );
  }
  return {
    bytes: buf.length,
    entry: m[1],
    sha256: sha256(buf),
    headers: Object.fromEntries(res.headers.entries()),
    html: text,
  };
}

const FIXTURES = ['main.py', 'shapes.py', 'utils.py', 'multi.py'];
const TARGET_A = { id: 'shapes.py::Shape.area', defLine: 14, label: 'Shape.area' };
const TARGET_B = { id: 'utils.py::Registry.add', defLine: 95, label: 'Registry.add' };
// I 组：fixtures/multi.py 里 caller 在 6/7/8 三行各调一次 callee，图上是一条 weight=3 的聚合边
const EDGE_SRC = 'multi.py::caller';
const EDGE_TGT = 'multi.py::callee';
const EDGE_LINES = [6, 7, 8];
const ROW_H = 20;

/**
 * "用户内容"标记集合：fixture 文件名 + 其中每个 def/class 名 + 若干代码行片段。
 * 这些字符串只要出现在任何一条真实网络请求的 URL 里（原文或 percent-encoded），
 * 就说明浏览器把用户代码发到网上去了 —— 这是要害承诺，不是风格问题。
 * 长度 < 5 的标记丢掉，免得偶然子串制造假阳性。
 */
function userContentTokens() {
  const set = new Set();
  for (const f of FIXTURES) {
    set.add(f);
    set.add(f.replace(/\.py$/i, ''));
    const text = fs.readFileSync(path.join(ROOT, 'fixtures', f), 'utf8');
    for (const m of text.matchAll(/\b(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]{4,})/g)) set.add(m[1]);
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length >= 12 && !t.startsWith('#')) set.add(t.slice(0, 24));
    }
  }
  return [...set].filter((t) => t.length >= 5);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), steps: [], checks: [], samples: [] };

function note(name, value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  report.steps.push({ name, value: s.length > 4000 ? s.slice(0, 4000) + '...(cut)' : s });
  console.log('== ' + name + ' == ' + (s.length > 1500 ? s.slice(0, 1500) + '...(cut)' : s));
}

function check(name, pass, detail) {
  report.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : String(detail) });
  console.log((pass ? '[PASS] ' : '[FAIL] ') + name + (detail === undefined ? '' : '  -- ' + detail));
  return !!pass;
}

async function waitForTarget(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 25000)) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP target never appeared on port ' + PORT);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error((p.method || '?') + ': ' + msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) for (const cb of cbs) cb(msg.params);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 60000);
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
}

async function evalJs(cdp, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: !!awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
  }
  return r.result ? r.result.value : undefined;
}

async function shot(cdp, name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    note('screenshot', f);
    return f;
  } catch (e) {
    note('screenshot-failed', String(e && e.message));
    return null;
  }
}

async function realClick(cdp, x, y) {
  const cx = Math.round(x * 100) / 100;
  const cy = Math.round(y * 100) / 100;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0, clickCount: 0 });
  await sleep(70);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
}

async function focusElement(cdp, id) {
  let box = await evalJs(cdp, 'window.__t.ensureCenter(' + JSON.stringify(id) + ')');
  if (!box) throw new Error('element not found: ' + id);
  if (box.scrolled) {
    await sleep(500);
    box = await evalJs(cdp, 'window.__t.centerOf(' + JSON.stringify(id) + ')');
    if (!box) throw new Error('element lost after scrolling: ' + id);
  }
  if (!(box.x > 0 && box.x < 1600 && box.y > 0 && box.y < 1000)) {
    throw new Error('element not clickable (outside 1600x1000 viewport): ' + id + ' ' + JSON.stringify(box));
  }
  return box;
}

async function clickTestId(cdp, id) {
  const box = await evalJs(cdp, 'window.__t.centerOf("' + id + '")');
  if (!box) throw new Error('element not found: ' + id);
  await realClick(cdp, box.x, box.y);
  return box;
}

// ---------------------------------------------------------------------------
// CDP 端口与 profile：宁可用第二个端口，也绝不连一个不是我起的调试端点。
// 上一轮残留的 headless Chrome 会同时占着 9333 和 profile 目录，直接复用的话
// 这一轮的断言就跑在别人的浏览器实例 + 别人的 IndexedDB 会话上，绿灯是假的。
// ---------------------------------------------------------------------------
function isPortFree(p) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(p, '127.0.0.1');
  });
}

async function pickCdpPort() {
  for (let cand = PORT; cand < PORT + 8; cand++) {
    if (await isPortFree(cand)) {
      if (cand !== PORT) note('cdp port moved', PORT + ' 已被占用 -> 改用 ' + cand);
      PORT = cand;
      return;
    }
  }
  throw new Error(
    'CDP 端口 ' + PORT + '..' + (PORT + 7) + ' 全被占用。关掉残留的 headless Chrome，或用 CODEMAP_CDP_PORT 指定一个空闲端口。',
  );
}

function prepareProfile() {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (e) {
    const alt = PROFILE + '-' + process.pid;
    note('profile locked', (e.code || 'ERR') + '：' + path.basename(PROFILE) + ' 被旧 Chrome 占着 -> 用 ' + path.basename(alt));
    try { fs.rmSync(alt, { recursive: true, force: true }); } catch { /* ignore */ }
    PROFILE = alt;
  }
}

async function launch(flag) {
  const args = [
    flag,
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=1600,1000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--hide-scrollbars',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--in-process-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=GpuPersistentCache,DawnGraphiteCache',
    'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d.toString(); });
  const handle = { chrome, stderr: () => buf };
  globalThis.PROC = handle;
  return handle;
}

// ---------------------------------------------------------------------------
// 主题契约：色值、变量条数、localStorage 键名、注入的 meta 与壳层底色全部从源码读，
// 不在冒烟脚本里再抄一份 —— 理由同 contactContract()：抄一份的话改源码的人不会被拦。
// 读不到就抛 —— 静默跳过的守卫比红灯更糟。
// ---------------------------------------------------------------------------
function themeContract() {
  // 统一换行再匹配：块边界按 LF 找，Windows 上 git 检出成 CRLF 也不能让契约读不到
  const lf = (s) => s.replace(/\r\n/g, '\n');
  const themeSrc = lf(fs.readFileSync(path.join(ROOT, 'src/theme.ts'), 'utf8'));
  const varsSrc = lf(fs.readFileSync(path.join(ROOT, 'src/platform/web/themeVars.ts'), 'utf8'));
  const headSrc = lf(fs.readFileSync(path.join(ROOT, 'scripts/inject-html-head.mjs'), 'utf8'));
  const die = (m) => {
    throw new Error('主题契约读不到（被改掉了？）: ' + m);
  };
  const prefKey = /^export const THEME_PREF_KEY = '([^']+)';/m.exec(varsSrc);
  if (!prefKey) die('THEME_PREF_KEY');
  const order = /export const THEME_ORDER[^=]*=\s*\[([\s\S]*?)\]/.exec(themeSrc);
  if (!order) die('THEME_ORDER');
  const ids = (order[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  const dflt = /export const DEFAULT_THEME[^=]*=\s*'([^']+)'/.exec(themeSrc);
  if (!dflt) die('DEFAULT_THEME');
  if (!ids.includes(dflt[1])) die('DEFAULT_THEME 不在 THEME_ORDER 里: ' + dflt[1]);
  const isHex = (v) => typeof v === 'string' && v.charAt(0) === '#' && v.length === 7 && /^[0-9a-fA-F]{6}$/.test(v.slice(1));
  const kebab = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const palettes = {};
  for (const id of ids) {
    const start = themeSrc.indexOf("  '" + id + "': {");
    if (start < 0) die('主题块 ' + id);
    const end = themeSrc.indexOf('\n  },\n', start);
    if (end < 0) die('主题块收尾 ' + id);
    const body = themeSrc.slice(start, end);
    const label = /label: '([^']+)',/.exec(body);
    const scheme = /scheme: '(dark|light)',/.exec(body);
    const colorBlock = /\n    colors: \{([\s\S]*?)\n    \},/.exec(body);
    const tokenBlock = /\n    tokenColors: \{([\s\S]*?)\n    \},/.exec(body);
    const fileBlock = /\n    fileColors: \[([\s\S]*?)\]/.exec(body);
    if (!label || !scheme || !colorBlock || !tokenBlock || !fileBlock) die('主题块字段 ' + id);
    const vars = {};
    for (const m of colorBlock[1].matchAll(/([A-Za-z]+):\s*'([^']+)'/g)) {
      vars['--cm-' + kebab(m[1])] = m[2];
    }
    for (const m of tokenBlock[1].matchAll(/([A-Za-z]+):\s*'([^']+)'/g)) {
      vars['--cm-tok-' + kebab(m[1])] = m[2];
    }
    (fileBlock[1].match(/'[^']+'/g) || []).forEach((s, i) => {
      vars['--cm-file-' + i] = s.slice(1, -1);
    });
    if (!isHex(vars['--cm-bg'])) die('主题 ' + id + ' 的 bg 不是 6 位 hex: ' + vars['--cm-bg']);
    palettes[id] = { id: id, label: label[1], scheme: scheme[1], bg: vars['--cm-bg'], vars: vars };
  }
  const sizes = {};
  ids.forEach((id) => {
    sizes[Object.keys(palettes[id].vars).length] = true;
  });
  const counts = Object.keys(sizes);
  if (counts.length !== 1) die('各主题变量条数不一致: ' + counts.join('/'));
  const varCount = Number(counts[0]);
  const shell = /export const SHELL_STYLE = '([^']+)';/.exec(headSrc);
  if (!shell) die('SHELL_STYLE');
  const meta = /\{ name: 'theme-color', content: '([^']+)' \}/.exec(headSrc);
  if (!meta) die('theme-color meta');
  const defaultBg = palettes[dflt[1]].bg;
  if (shell[1].indexOf('--cm-bg:' + defaultBg) < 0) die('壳层底色的 --cm-bg != 默认主题 bg: ' + shell[1]);
  if (meta[1] !== defaultBg) die('theme-color != 默认主题 bg: ' + meta[1]);
  return {
    prefKey: prefKey[1],
    ids: ids,
    defaultId: dflt[1],
    palettes: palettes,
    varCount: varCount,
    shellStyle: shell[1],
    metaColor: meta[1],
  };
}

// 在模块作用域就算：契约错了要立刻炸，别等三分钟的真浏览器跑完才说
const THEME = themeContract();

// ---------------------------------------------------------------------------
// page-side harness: installed once, then called with tiny expressions so we
// never have to fight nested quoting.
// ---------------------------------------------------------------------------
const HARNESS = `
(function () {
  function byId(id) {
    return document.querySelector('[data-testid="' + id + '"]') || document.querySelector('[testid="' + id + '"]');
  }
  function allByPrefix(prefix) {
    var a = Array.prototype.slice.call(document.querySelectorAll('[data-testid^="' + prefix + '"]'));
    var b = Array.prototype.slice.call(document.querySelectorAll('[testid^="' + prefix + '"]'));
    return a.concat(b);
  }
  function tid(el) {
    return el.getAttribute('data-testid') || el.getAttribute('testid') || '';
  }
  function txt(el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  function scrollEl() {
    var s = byId('code-scroll');
    if (!s) return null;
    if (s.scrollHeight > s.clientHeight + 1) return s;
    var kids = s.querySelectorAll('div');
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].scrollHeight > kids[i].clientHeight + 1) return kids[i];
    }
    return s;
  }
  function activeTab() {
    var allChips = allByPrefix('chip-');
    var tabs = [];
    for (var j = 0; j < allChips.length; j++) {
      var t = tid(allChips[j]);
      if (t.indexOf('chip-remove-') !== 0) tabs.push(allChips[j]);
    }
    var out = [];
    var active = null;
    for (var i = 0; i < tabs.length; i++) {
      var cs = getComputedStyle(tabs[i]);
      var p = tid(tabs[i]).replace('chip-', '');
      out.push(p);
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') active = p;
    }
    return { tabs: out, active: active };
  }
  function findNode(funcId) {
    var el = byId('graph-node-' + funcId);
    var how = el ? 'testid' : null;
    if (!el) {
      var svg = byId('graph-svg') || document.querySelector('svg');
      var want = funcId.split('::')[1];
      if (svg) {
        var ts = svg.querySelectorAll('text');
        for (var i = 0; i < ts.length; i++) {
          var t = (ts[i].textContent || '').trim();
          if (t === want || t.indexOf(want) === 0) { el = ts[i].closest('g'); how = 'text-scan'; break; }
        }
      }
    }
    if (!el) return null;
    var r = rect(el);
    r.how = how;
    r.tag = el.tagName;
    r.attrs = el.getAttributeNames().join(',');
    r.opacity = el.getAttribute('opacity');
    var cs = getComputedStyle(el);
    r.cssOpacity = cs.opacity;
    var inner = el.querySelector('rect');
    r.stroke = inner ? inner.getAttribute('stroke') : null;
    r.strokeWidth = inner ? inner.getAttribute('stroke-width') : null;
    return r;
  }
  function flashInfo() {
    var el = byId('code-flash');
    if (!el) return null;
    var cs = getComputedStyle(el);
    return {
      opacity: parseFloat(cs.opacity),
      inlineOpacity: el.style.opacity,
      top: el.style.top,
      height: el.style.height,
      bg: cs.backgroundColor
    };
  }
  function sample() {
    var sc = scrollEl();
    var band = byId('code-selection-band');
    return {
      at: Date.now(),
      flash: flashInfo(),
      band: band ? { top: band.style.top, height: band.style.height, borderLeft: getComputedStyle(band).borderLeftWidth } : null,
      scrollTop: sc ? sc.scrollTop : null,
      selInfo: txt(byId('graph-selection-info')),
      zoom: txt(byId('graph-zoom-label')),
      active: activeTab(),
      line1: txt(byId('code-line-1'))
    };
  }
  function renderedLines() {
    return allByPrefix('code-line-').map(function (el) {
      return parseInt(tid(el).replace('code-line-', ''), 10);
    }).sort(function (a, b) { return a - b; });
  }
  function lineVisible(n) {
    var el = byId('code-line-' + n);
    if (!el) return { rendered: false };
    var sc = scrollEl();
    var cr = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    var r = el.getBoundingClientRect();
    return {
      rendered: true,
      text: txt(el),
      top: r.top,
      bottom: r.bottom,
      containerTop: cr.top,
      containerBottom: cr.bottom,
      fullyVisible: r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1
    };
  }
  function centerOf(id) { return rect(byId(id)); }
  function inViewport(r) {
    return !!r && r.w > 0 && r.h > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
  }
  function ensureCenter(id) {
    var el = byId(id);
    if (!el) return null;
    var r = rect(el);
    var was = inViewport(r);
    if (!was) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      r = rect(byId(id) || el);
    }
    r.wasInViewport = was;
    r.scrolled = !was;
    return r;
  }
  function tokenInfo(id) {
    var el = byId(id);
    if (!el) return null;
    return { id: id, text: txt(el), tag: el.tagName, box: rect(el) };
  }
  function drop(defs) {
    var dt = new DataTransfer();
    for (var i = 0; i < defs.length; i++) {
      dt.items.add(new File([defs[i].content], defs[i].name, { type: 'text/x-python' }));
    }
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return dt.files.length;
  }
  function probe() {
    var root = document.querySelector('[data-testid="app-root"]');
    var root2 = document.querySelector('[testid="app-root"]');
    var svg = byId('graph-svg');
    var firstNode = allByPrefix('graph-node-')[0] || null;
    return {
      dataTestidWorks: !!root,
      lowerTestidWorks: !!root2,
      svgTag: svg ? svg.tagName : null,
      svgAttrs: svg ? svg.getAttributeNames().join(',') : null,
      nodeCount: allByPrefix('graph-node-').length,
      firstNodeTag: firstNode ? firstNode.tagName : null,
      firstNodeAttrs: firstNode ? firstNode.getAttributeNames().join(',') : null,
      firstNodeId: firstNode ? tid(firstNode) : null,
      bodyChildren: document.body.children.length,
      innerSize: window.innerWidth + 'x' + window.innerHeight
    };
  }
  function stats() {
    return {
      stats: txt(byId('topbar-stats')),
      reasons: txt(byId('topbar-stats-reasons')),
      error: txt(byId('topbar-error')),
      warnings: txt(byId('topbar-warnings')),
      progress: txt(byId('topbar-progress')),
      nodes: allByPrefix('graph-node-').length,
      edges: allByPrefix('graph-edge-').length,
      tabs: activeTab(),
      empty: !!byId('upload-panel')
    };
  }
  function themeState(prefKey) {
    var inline = document.documentElement.style;
    var vars = {};
    var n = 0;
    for (var i = 0; i < inline.length; i++) {
      var name = inline.item(i);
      if (name.indexOf('--cm-') === 0) {
        vars[name] = inline.getPropertyValue(name).trim();
        n++;
      }
    }
    var metas = Array.prototype.slice.call(document.getElementsByTagName('meta'));
    var metaContent = null;
    var metaCount = 0;
    for (var j = 0; j < metas.length; j++) {
      if (metas[j].getAttribute('name') === 'theme-color') {
        metaCount++;
        metaContent = metas[j].getAttribute('content');
      }
    }
    var shell = document.querySelector('style[data-codemap="shell"]');
    var root = byId('app-root');
    var node = allByPrefix('graph-node-')[0] || null;
    var fillEl = node ? (node.querySelector('rect') || node) : null;
    var pref = null;
    var prefErr = null;
    try {
      pref = window.localStorage.getItem(prefKey);
    } catch (e) {
      prefErr = String(e && e.name);
    }
    var cs = getComputedStyle(document.documentElement);
    return {
      varCount: n,
      vars: vars,
      colorSchemeInline: inline.colorScheme || null,
      colorSchemeComputed: cs.colorScheme || null,
      metaContent: metaContent,
      metaCount: metaCount,
      shellStyle: shell ? (shell.textContent || '').trim() : null,
      rootBg: root ? getComputedStyle(root).backgroundColor : null,
      nodeFillComputed: fillEl ? getComputedStyle(fillEl).fill : null,
      nodeFillAttr: fillEl ? fillEl.getAttribute('fill') : null,
      pref: pref,
      prefErr: prefErr
    };
  }
  // 面板的结构证据一次取齐：行顺序 / 标签 / 可访问名 / 哪一行有勾 / 预览块的内联样式
  function themePanel() {
    var p = byId('theme-panel');
    if (!p) return null;
    var TICK = String.fromCharCode(0x2713);
    var rows = Array.prototype.slice.call(allByPrefix('theme-option-'));
    var labels = [];
    var aria = [];
    var checked = [];
    var swatchCss = '';
    rows.forEach(function (r) {
      var text = (r.textContent || '').trim();
      labels.push(text);
      aria.push(r.getAttribute('aria-label'));
      if (text.indexOf(TICK) >= 0) checked.push(tid(r));
      var box = r.firstElementChild;
      var kids = box ? Array.prototype.slice.call(box.children) : [];
      kids.forEach(function (k) {
        swatchCss = swatchCss + ' ' + (k.getAttribute('style') || '');
      });
    });
    return { rows: rows.map(tid), labels: labels, aria: aria, checked: checked, swatchCss: swatchCss };
  }
  // 「浮在最上面」的判据和 G6 同一个：这一点上 elementFromPoint 命中的必须是被测元素自己
  function topmostInPanel(id) {
    var el = byId(id);
    var panel = byId('theme-panel');
    if (!el || !panel) return null;
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var hit = document.elementFromPoint(x, y);
    return {
      x: Math.round(x),
      y: Math.round(y),
      hit: hit ? hit.tagName + '#' + (hit.getAttribute('data-testid') || hit.id || '') : 'none',
      insidePanel: !!(hit && panel.contains(hit))
    };
  }
  /**
   * 取「graph-edge-<src>-><tgt>」这根 <g> 里最长的那条 <path>（线本体，箭头很短），
   * 用 getPointAtLength + getScreenCTM 算出一个真正的屏幕坐标点 —— 折线的几何只有
   * 真浏览器给得出来，jsdom 里全是 0。顺带用 elementFromPoint 证明这一点确实落在这条
   * 边上（没被节点方块或浮层抢走），抢不到就换个 fraction 再试。
   */
  function edgeProbe(source, target, fraction) {
    var id = 'graph-edge-' + source + '->' + target;
    var g = byId(id);
    if (!g) return { id: id, found: false };
    var paths = g.querySelectorAll('path');
    var line = null;
    var len = -1;
    for (var i = 0; i < paths.length; i++) {
      var L = 0;
      try { L = paths[i].getTotalLength(); } catch (e) { L = 0; }
      if (L > len) { len = L; line = paths[i]; }
    }
    if (!line || len <= 0) return { id: id, found: true, usable: false, paths: paths.length };
    var f = typeof fraction === 'number' ? fraction : 0.5;
    var p = line.getPointAtLength(len * f);
    var m = line.getScreenCTM();
    if (!m) return { id: id, found: true, usable: false, reason: 'no-screen-ctm' };
    var sx = m.a * p.x + m.c * p.y + m.e;
    var sy = m.b * p.x + m.d * p.y + m.f;
    var hit = document.elementFromPoint(sx, sy);
    var host = hit && hit.closest ? hit.closest('g[data-testid]') : null;
    return {
      id: id, found: true, usable: true, x: sx, y: sy, fraction: f, len: Math.round(len),
      stroke: line.getAttribute('stroke'), strokeWidth: line.getAttribute('stroke-width'),
      hit: hit ? hit.tagName + '#' + tid(hit) : 'none',
      host: host ? tid(host) : 'none',
      onEdge: !!host && tid(host) === id
    };
  }
  /** 边选中在页面上的全部可见痕迹：步进器 / 底栏 / 三处打点 / 闪烁行 / 当前文件首行 / hover */
  function edgeState() {
    var marks = allByPrefix('callsite-mark-').map(function (el) {
      return { id: tid(el), left: el.style.left, top: el.style.top, width: el.style.width };
    });
    // 序号角标渲染在行内的 sticky gutter 里（不是内容坐标的覆盖层），style.left 是空的，
    // 所以位置只能量「相对所在行左缘」的矩形：行号槽宽 58，数字右对齐占 20..50，角标必须 &lt;= 20
    var chip = byId('callsite-mark-active');
    var chipRel = null;
    if (chip && chip.closest) {
      var chipRow = chip.closest('[data-testid^="code-line-"]');
      if (chipRow) {
        var chR = chip.getBoundingClientRect();
        var rwR = chipRow.getBoundingClientRect();
        chipRel = {
          inRow: tid(chipRow),
          text: (chip.textContent || '').trim(),
          relLeft: Math.round(chR.left - rwR.left),
          relRight: Math.round(chR.right - rwR.left)
        };
      }
    }
    var sc = scrollEl();
    var canvas = byId('graph-canvas');
    return {
      stepper: !!byId('callsite-stepper'),
      count: txt(byId('callsite-count')),
      info: txt(byId('graph-edge-info')),
      hasPrev: !!byId('callsite-prev'),
      hasNext: !!byId('callsite-next'),
      tip: txt(byId('graph-edge-tooltip')),
      cursor: canvas ? getComputedStyle(canvas).cursor : null,
      marks: marks,
      chip: chipRel,
      flash: flashInfo(),
      line1: txt(byId('code-line-1')),
      scrollTop: sc ? sc.scrollTop : null
    };
  }
  window.__t = {
    byId: byId, allByPrefix: allByPrefix, tid: tid, txt: txt, rect: rect,
    edgeProbe: edgeProbe, edgeState: edgeState,
    findNode: findNode, sample: sample, renderedLines: renderedLines,
    lineVisible: lineVisible, centerOf: centerOf, ensureCenter: ensureCenter,
    tokenInfo: tokenInfo, drop: drop, probe: probe,
    stats: stats, activeTab: activeTab, scrollEl: scrollEl,
    themeState: themeState, themePanel: themePanel, topmostInPanel: topmostInPanel
  };
  return 'harness-ok';
})()
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function poll(cdp, expr, ok, timeoutMs, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    try {
      last = await evalJs(cdp, expr);
      if (ok(last)) return { ok: true, value: last, ms: Date.now() - t0 };
    } catch (e) { last = 'ERR ' + e.message; }
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + (label || expr) + ' last=' + JSON.stringify(last).slice(0, 400));
}

// ---------------------------------------------------------------------------
// 反馈面板的期望值从源码里读，不在冒烟脚本里再抄一份：门控常量一改，断言跟着改，
// 不会出现「冒烟还绿着，但它测的已经不是源码了」。读不到就抛 —— 静默跳过的守卫
// 比红灯更糟：那条红灯本来要防的正是「契约被改掉而没人发现」。
// ---------------------------------------------------------------------------
function contactContract() {
  const file = path.join(ROOT, 'src/feedback/contact.ts');
  const src = fs.readFileSync(file, 'utf8');
  const email = /^export const CONTACT_EMAIL[^=]*=\s*(null|'[^']*');/m.exec(src);
  if (!email) throw new Error('读不到 CONTACT_EMAIL 常量（契约被改掉？）: ' + file);
  const alias = email[1] === 'null' ? null : email[1].slice(1, -1);
  const issues = /^export const REPO_ISSUES_URL = '([^']+)';/m.exec(src);
  if (!issues) throw new Error('读不到 REPO_ISSUES_URL 常量（契约被改掉？）: ' + file);
  const fields = /export const DIAG_FIELD_NAMES[\s\S]*?\[([\s\S]*?)\] as const/.exec(src);
  if (!fields) throw new Error('读不到 DIAG_FIELD_NAMES 白名单（契约被改掉？）: ' + file);
  const names = (fields[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  if (names.length < 1) throw new Error('DIAG_FIELD_NAMES 解析出 0 个字段: ' + file);
  return { alias, issuesUrl: issues[1], fieldNames: names };
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/index.html 不存在，请先运行 npm run export 产出静态站点');
  }
  const srv = await startStaticServer();
  globalThis.SRV = srv;
  note('static server', srv.reused ? 'reused :' + APP_PORT : 'started :' + APP_PORT);
  const expectIndex = distIndex();
  note('dist/index.html', expectIndex);
  note(
    'header rules loaded',
    HEADER_RULES.length
      ? HEADER_RULES.map((r) => r.pattern + ' -> ' + r.headers.map((h) => h[0]).join(',')).join(' | ')
      : '(没有 dist/_headers，本地冒烟将跑在无 CSP 下)',
  );
  const servedIndex = await probeAppUrl();
  note('app url probe', APP_URL + ' html=' + servedIndex.bytes + 'B entry=' + servedIndex.entry);
  check(
    'S1 本地服务端出来的就是当前 dist/ 的字节',
    servedIndex.sha256 === expectIndex.sha256 && servedIndex.entry === expectIndex.entry,
    'served sha=' + servedIndex.sha256.slice(0, 16) + ' dist sha=' + expectIndex.sha256.slice(0, 16),
  );
  check(
    'S2 _headers 真的生效了（响应里带 CSP）',
    !!servedIndex.headers['content-security-policy'],
    servedIndex.headers['content-security-policy'] || '响应里没有 content-security-policy',
  );
  check(
    'S3 上线 HTML 字节里零绝对 URL（含注释）',
    (servedIndex.html.match(ABS_URL_RE) || []).length === 0,
    (servedIndex.html.match(ABS_URL_RE) || []).join(' ') || '0 个',
  );

  await pickCdpPort();
  prepareProfile();
  let proc = await launch('--headless=new');
  let wsUrl;
  try {
    wsUrl = await waitForTarget(25000);
    report.headless = '--headless=new';
  } catch {
    note('headless=new failed', proc.stderr().slice(-500));
    proc.chrome.kill();
    await sleep(1500);
    proc = await launch('--headless');
    wsUrl = await waitForTarget(25000);
    report.headless = '--headless';
  }
  note('cdp target', wsUrl);
  const cdp = await CDP.connect(wsUrl);
  globalThis.CDP = cdp;

  const console_ = [];
  const exceptions = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      console_.push(p.type + ': ' + p.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' ').slice(0, 300));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    exceptions.push(JSON.stringify(p.exceptionDetails).slice(0, 500));
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && (p.entry.level === 'error')) console_.push('log: ' + String(p.entry.text).slice(0, 300));
  });

  // ============ 承诺面取证：记下浏览器真实发出的每一个请求 ============
  const netRequests = new Map();
  cdp.on('Network.requestWillBeSent', (p) => {
    const rq = p.request || {};
    netRequests.set(p.requestId, {
      url: rq.url,
      method: rq.method,
      kind: p.type,
      hasPostData: !!rq.hasPostData,
      postDataBytes: rq.postData ? Buffer.byteLength(rq.postData) : 0,
    });
  });
  cdp.on('Network.responseReceived', (p) => {
    const rec = netRequests.get(p.requestId);
    if (rec) rec.status = p.response ? p.response.status : null;
  });
  cdp.on('Network.loadingFailed', (p) => {
    const rec = netRequests.get(p.requestId);
    if (rec) rec.failed = p.errorText || 'failed';
  });

  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  // CSP 违规不会在控制台留下稳定文本，自己在文档创建前装好计数器
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "window.__cspViolations=[];window.addEventListener('securitypolicyviolation',function(e){" +
      'window.__cspViolations.push({blocked:e.blockedURI,directive:e.violatedDirective,original:e.originalURL});});',
  });
  await cdp.send('Page.navigate', { url: APP_URL });

  await poll(cdp, 'document.querySelector(\'[data-testid="app-root"]\') || document.querySelector(\'[testid="app-root"]\') ? 1 : 0', (v) => v === 1, 45000, 'app-root');
  note('boot', 'app-root rendered');

  const harness = await evalJs(cdp, HARNESS);
  note('harness', harness);

  const probe0 = await evalJs(cdp, 'window.__t.probe()');
  note('probe(before upload)', probe0);
  await shot(cdp, '01-initial.png');

  // ---- upload via a synthetic drop (the handler lives on window) ----
  const defs = FIXTURES.map((f) => ({ name: f, content: fs.readFileSync(path.join(ROOT, 'fixtures', f), 'utf8') }));
  const dropped = await evalJs(cdp, 'window.__t.drop(' + JSON.stringify(defs) + ')');
  note('files dropped', dropped);

  const t0 = Date.now();
  const st = await poll(cdp, 'window.__t.stats()', (s) => s.nodes > 0 || !!s.error, 60000, 'graph nodes').then((r) => r.value);
  note('parse wall ms', Date.now() - t0);
  note('stats after upload', st);
  check('no fatal error bar', !st.error, st.error || 'none');
  check('graph rendered', st.nodes > 0, 'nodes=' + st.nodes + ' edges=' + st.edges);
  note('stats line', st.stats + ' | ' + st.reasons);
  await shot(cdp, '02-loaded.png');

  const probe1 = await evalJs(cdp, 'window.__t.probe()');
  note('probe(after upload)', probe1);

  const before = await evalJs(cdp, 'window.__t.sample()');
  note('state before graph click', before);

  // ================= ACCEPTANCE 1: graph -> code =================
  await clickTestId(cdp, 'graph-fit');
  await sleep(400);

  const boxA = await evalJs(cdp, 'window.__t.findNode(' + JSON.stringify(TARGET_A.id) + ')');
  note('node box ' + TARGET_A.id, boxA);
  if (!boxA) throw new Error('graph node not found: ' + TARGET_A.id);
  check('node center inside viewport', boxA.x > 0 && boxA.x < 1600 && boxA.y > 0 && boxA.y < 1000, JSON.stringify({ x: boxA.x, y: boxA.y }));

  await realClick(cdp, boxA.x, boxA.y);
  const traceA = [];
  const clickAt = Date.now();
  while (Date.now() - clickAt < 1800) {
    const s = await evalJs(cdp, 'window.__t.sample()');
    traceA.push({ dt: Date.now() - clickAt, op: s.flash ? s.flash.opacity : null, has: !!s.flash, top: s.scrollTop, sel: s.selInfo });
    await sleep(90);
  }
  report.samples.push({ name: 'graph->code ' + TARGET_A.id, trace: traceA });
  note('flash trace (dt, opacity, scrollTop)', traceA.map((t) => t.dt + 'ms:' + (t.has ? t.op.toFixed(3) : '-') + ':' + t.top).join(' '));

  const afterA = await evalJs(cdp, 'window.__t.sample()');
  const lineA = await evalJs(cdp, 'window.__t.lineVisible(' + TARGET_A.defLine + ')');
  note('after graph click', Object.assign({}, afterA, { line: lineA }));
  await shot(cdp, '03-after-graph-click.png');

  // FileTabs removed, active chip detection unreliable
  check('A1 selection info names the function', afterA.selInfo.indexOf(TARGET_A.label) >= 0, afterA.selInfo);
  check('A1 selection band present', !!afterA.band, JSON.stringify(afterA.band));
  check('A1 band starts at def line', afterA.band && parseInt(afterA.band.top, 10) === (TARGET_A.defLine - 1) * ROW_H, 'top=' + (afterA.band && afterA.band.top) + ' expected=' + ((TARGET_A.defLine - 1) * ROW_H));
  check('A1 def line rendered and fully visible', lineA.rendered && lineA.fullyVisible, JSON.stringify(lineA));
  check('A1 def line text is the def', lineA.text && lineA.text.indexOf('def area') >= 0, lineA.text);

  const flashSeen = traceA.filter((t) => t.has);
  check('A1 flash overlay appeared', flashSeen.length > 0, 'samples with flash=' + flashSeen.length + '/' + traceA.length);
  const firstOp = flashSeen.length ? flashSeen[0].op : -1;
  check('A1 flash starts near peak opacity', firstOp > 0.35 && firstOp <= 0.9, 'first sampled opacity=' + firstOp);
  const lastOp = flashSeen.length ? flashSeen[flashSeen.length - 1].op : -1;
  check('A1 flash fades out', flashSeen.length > 2 && lastOp < firstOp, 'first=' + firstOp + ' last=' + lastOp);
  check('A1 flash unmounted after FLASH_MS', !afterA.flash, 'flash=' + JSON.stringify(afterA.flash));

  // ---- repeat click on the same node: nonce must retrigger the flash ----
  const boxA2 = await evalJs(cdp, 'window.__t.findNode(' + JSON.stringify(TARGET_A.id) + ')');
  if (!boxA2) throw new Error('node vanished: ' + TARGET_A.id);
  await realClick(cdp, boxA2.x, boxA2.y);
  await sleep(150);
  const mid = await evalJs(cdp, 'window.__t.sample()');
  await shot(cdp, '04-flash-midflight.png');
  note('mid-flash sample (repeat click)', mid);
  check('A2 repeat click re-triggers the flash', !!mid.flash, JSON.stringify(mid.flash));
  await sleep(1600);
  const afterA2 = await evalJs(cdp, 'window.__t.sample()');
  check('A2 flash unmounted again', !afterA2.flash, JSON.stringify(afterA2.flash));

  // ================= ACCEPTANCE 2: code -> graph =================
  const markBox = await focusElement(cdp, 'code-def-mark-48');
  note('def-mark box (shapes.py line 48 = total_area)', markBox);
  if (!markBox) throw new Error('missing code-def-mark-48');
  const nodeBefore = await evalJs(cdp, 'window.__t.findNode("shapes.py::total_area")');
  await realClick(cdp, markBox.x, markBox.y);
  const traceB = [];
  const tb = Date.now();
  while (Date.now() - tb < 900) {
    const s = await evalJs(cdp, 'window.__t.sample()');
    traceB.push({ dt: Date.now() - tb, has: !!s.flash, op: s.flash ? s.flash.opacity : null, sel: s.selInfo });
    await sleep(90);
  }
  report.samples.push({ name: 'code->graph total_area', trace: traceB });
  const afterB = await evalJs(cdp, 'window.__t.sample()');
  const nodeAfter = await evalJs(cdp, 'window.__t.findNode("shapes.py::total_area")');
  const canvas = await evalJs(cdp, 'window.__t.centerOf("graph-canvas")');
  note('code->graph', { selInfo: afterB.selInfo, nodeBefore, nodeAfter, canvas });
  await shot(cdp, '05-after-code-click.png');

  check('B1 selection info names total_area', afterB.selInfo.indexOf('total_area') >= 0, afterB.selInfo);
  check('B1 code -> graph does NOT flash', !traceB.some((t) => t.has) && !afterB.flash, JSON.stringify(afterB.flash));
  check('B1 selection band still drawn', !!afterB.band, JSON.stringify(afterB.band));
  const dx = nodeAfter && canvas ? Math.abs(nodeAfter.x - canvas.x) : 99999;
  const dy = nodeAfter && canvas ? Math.abs(nodeAfter.y - canvas.y) : 99999;
  check('B1 target node centered in the graph viewport', dx < 40 && dy < 40, 'dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1));
  check('B1 target node gets the selected stroke', nodeAfter && nodeAfter.strokeWidth && parseFloat(nodeAfter.strokeWidth) >= 2.5, 'strokeWidth=' + (nodeAfter && nodeAfter.strokeWidth) + ' stroke=' + (nodeAfter && nodeAfter.stroke));

  // ================= deep cross-file jump (must really scroll) =================
  await clickTestId(cdp, 'graph-fit');
  await sleep(400);
  const boxB = await evalJs(cdp, 'window.__t.findNode(' + JSON.stringify(TARGET_B.id) + ')');
  note('node box ' + TARGET_B.id, boxB);
  if (!boxB) throw new Error('graph node not found: ' + TARGET_B.id);
  const preC = await evalJs(cdp, 'window.__t.sample()');
  await realClick(cdp, boxB.x, boxB.y);
  const traceC = [];
  const tc = Date.now();
  while (Date.now() - tc < 900) {
    const s = await evalJs(cdp, 'window.__t.sample()');
    traceC.push({ dt: Date.now() - tc, has: !!s.flash, op: s.flash ? s.flash.opacity : null, top: s.scrollTop });
    await sleep(90);
  }
  report.samples.push({ name: 'graph->code deep ' + TARGET_B.id, trace: traceC });
  const afterC = await evalJs(cdp, 'window.__t.sample()');
  const lineC = await evalJs(cdp, 'window.__t.lineVisible(' + TARGET_B.defLine + ')');
  note('deep cross-file', { pre: preC, after: afterC, line: lineC, trace: traceC.map((t) => t.dt + 'ms:' + (t.has ? t.op.toFixed(3) : '-') + ':' + t.top).join(' ') });
  await shot(cdp, '06-deep-crossfile.png');

  // FileTabs removed, active chip detection unreliable
  check('C1 really scrolled down', afterC.scrollTop > 500, 'scrollTop=' + afterC.scrollTop + ' (was ' + preC.scrollTop + ')');
  check('C1 def line 95 rendered and fully visible', lineC.rendered && lineC.fullyVisible, JSON.stringify(lineC));
  check('C1 band sits on line 95', afterC.band && parseInt(afterC.band.top, 10) === (TARGET_B.defLine - 1) * ROW_H, JSON.stringify(afterC.band));
  check('C1 flash appeared on the deep cross-file jump', traceC.some((t) => t.has), 'flashSamples=' + traceC.filter((t) => t.has).length);

  // ================= call-site token selects the callee (informational) =================
  // utils.py:54 is `return parse_lines(read_text(path))`; the first call token is parse_lines
  const linesNow = await evalJs(cdp, 'window.__t.renderedLines()');
  note('rendered code lines (windowed)', { count: linesNow.length, first: linesNow[0], last: linesNow[linesNow.length - 1] });
  const callTok = await evalJs(cdp, 'window.__t.tokenInfo("code-token-call-54")');
  note('call token code-token-call-54', callTok);
  if (!callTok) throw new Error('missing code-token-call-54');
  const callBox = await focusElement(cdp, 'code-token-call-54');
  const selBeforeD = (await evalJs(cdp, 'window.__t.sample()')).selInfo;
  await realClick(cdp, callBox.x, callBox.y);
  await sleep(500);
  const selAfterD = (await evalJs(cdp, 'window.__t.sample()')).selInfo;
  note('call token click', { token: callTok.text, selBefore: selBeforeD, selAfter: selAfterD });
  check('D1 clicking a call site selects the callee', selAfterD.indexOf('parse_lines') >= 0, 'selBefore=' + selBeforeD + ' selAfter=' + selAfterD);

  // utils.py:53 is the docstring inside load_config -> body click selects the enclosing function
  const bodyBox = await focusElement(cdp, 'code-line-53');
  await realClick(cdp, bodyBox.x, bodyBox.y);
  await sleep(500);
  const afterD2 = await evalJs(cdp, 'window.__t.sample()');
  note('body line click (utils.py:53)', { selInfo: afterD2.selInfo, band: afterD2.band });
  check('D2 clicking a body line selects the enclosing function', afterD2.selInfo.indexOf('load_config') >= 0, afterD2.selInfo);
  check('D3 body click moves the selection band to load_config', afterD2.band && parseInt(afterD2.band.top, 10) === (52 - 1) * ROW_H, JSON.stringify(afterD2.band));

  // ================= I：点「调用关系图的线」→ 定位到 A 调用 B 的那一行 =================
  // 图上的一条边是同一对函数之间全部调用的聚合（ADR-0002）：fixtures/multi.py 里
  // caller 在 6/7/8 三行各调一次 callee，屏幕上仍然只有一根线。这一组验的就是
  // 「一根线怎么承载 N 次调用」：点一次落到第 1 处、重复点向后绕回、N 处全部打点、
  // 右下角步进器 ‹ › ✕、hover 提示；只有一处调用的那根线（N=1）在代码区什么都不铺；
  // 以及点线全程零网络上行（本地功能红线）。
  await clickTestId(cdp, 'scope-all');
  await sleep(250);
  await clickTestId(cdp, 'graph-fit');
  await sleep(450);
  const reqsBeforeEdge = netRequests.size;

  // 折线的几何只有真浏览器算得出来：取线上一个点，并要求 elementFromPoint 命中的
  // 确实是这根边（没被节点方块抢走）；抢不到就沿路径换个位置再试。
  let iPt = null;
  for (const iFr of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const iCand = await evalJs(
      cdp,
      'window.__t.edgeProbe(' +
        JSON.stringify(EDGE_SRC) +
        ',' +
        JSON.stringify(EDGE_TGT) +
        ',' +
        iFr +
        ')'
    );
    note('edgeProbe f=' + iFr, iCand);
    if (iCand && iCand.onEdge) {
      iPt = iCand;
      break;
    }
  }
  check(
    'I0 caller→callee 这条聚合边画出来了，而且线上取得到一个真能命中的屏幕点',
    !!iPt,
    iPt
      ? 'x=' + iPt.x.toFixed(1) + ' y=' + iPt.y.toFixed(1) + ' len=' + iPt.len + ' hit=' + iPt.hit
      : 'no'
  );
  if (!iPt) throw new Error('edge not hittable on screen: ' + EDGE_SRC + ' -> ' + EDGE_TGT);

  const iEdgeProbe = async (fraction) => {
    const c = await evalJs(
      cdp,
      'window.__t.edgeProbe(' +
        JSON.stringify(EDGE_SRC) +
        ',' +
        JSON.stringify(EDGE_TGT) +
        ',' +
        fraction +
        ')'
    );
    return c && c.onEdge ? c : null;
  };
  /** 真的把鼠标点在线本体上，走 GraphPane 的 hitTestEdge -> selectEdgeFromGraph */
  const tapEdge = async () => {
    let p = null;
    for (const f of [iPt.fraction, 0.5, 0.4, 0.6, 0.3]) {
      p = await iEdgeProbe(f);
      if (p) break;
    }
    if (!p) throw new Error('edge lost before click: ' + EDGE_SRC + ' -> ' + EDGE_TGT);
    await realClick(cdp, p.x, p.y);
    await sleep(300);
    return evalJs(cdp, 'window.__t.edgeState()');
  };
  const iMarkIds = (st) =>
    (st.marks || [])
      .map((m) => m.id)
      .sort()
      .join(' ');
  const iMarkLefts = (st) =>
    (st.marks || [])
      .filter((m) => /^callsite-mark-\d$/.test(m.id))
      .map((m) => parseInt(m.left, 10))
      .filter((n) => Number.isFinite(n));

  const i1 = await tapEdge();
  note('edge state after 1st click', i1);
  // 首行的 textContent 带着行号槽（'ƒ1' 之类），所以只能包含式判断，不能 anchored 正则
  check(
    'I1 点一次线就把代码区切到 multi.py（首行是它的文件说明）',
    i1.line1.indexOf('# multi.py') >= 0,
    i1.line1
  );
  check(
    'I1 第一次点落在第 1 处调用：步进器 1/3 + 底栏 multi.py:' + EDGE_LINES[0],
    i1.stepper === true && i1.count === '1/3' && i1.info.indexOf('multi.py:' + EDGE_LINES[0]) >= 0,
    'count=' + i1.count + ' info=' + i1.info
  );
  check(
    'I1 高亮闪烁正好压在第 ' + EDGE_LINES[0] + ' 行',
    !!i1.flash && parseInt(i1.flash.top, 10) === (EDGE_LINES[0] - 1) * ROW_H,
    'flash=' + JSON.stringify(i1.flash)
  );
  check(
    'I1 三处调用全都打了点，不是只显示最新那一处',
    iMarkIds(i1) === 'callsite-mark-0 callsite-mark-1 callsite-mark-2 callsite-mark-active',
    iMarkIds(i1)
  );
  const i1Lefts = iMarkLefts(i1);
  check(
    'I1 三个打点各自落在自己的调用列上（列 12 < 13 < 19 的可见证据）',
    i1Lefts.length === 3 && i1Lefts[0] < i1Lefts[1] && i1Lefts[1] < i1Lefts[2],
    JSON.stringify(i1.marks)
  );
  check(
    'I1 序号角标在当前那行的行号左边（在 sticky 的行号槽里，不压代码文字）',
    !!i1.chip &&
      i1.chip.inRow === 'code-line-' + EDGE_LINES[0] &&
      i1.chip.text === '1' &&
      i1.chip.relLeft >= 0 &&
      i1.chip.relRight <= 20,
    JSON.stringify(i1.chip)
  );

  const i2 = await tapEdge();
  note('edge state after 2nd click', i2);
  check(
    'I2 再点同一根线跳到第 2 处：2/3 + multi.py:' +
      EDGE_LINES[1] +
      ' + 闪第 ' +
      EDGE_LINES[1] +
      ' 行',
    i2.count === '2/3' &&
      i2.info.indexOf('multi.py:' + EDGE_LINES[1]) >= 0 &&
      !!i2.flash &&
      parseInt(i2.flash.top, 10) === (EDGE_LINES[1] - 1) * ROW_H,
    'count=' + i2.count + ' info=' + i2.info + ' flash=' + JSON.stringify(i2.flash)
  );

  const i3 = await tapEdge();
  note('edge state after 3rd click', i3);
  check(
    'I3 第三次点到第 3 处（最后一处）：3/3 + multi.py:' + EDGE_LINES[2],
    i3.count === '3/3' &&
      i3.info.indexOf('multi.py:' + EDGE_LINES[2]) >= 0 &&
      !!i3.flash &&
      parseInt(i3.flash.top, 10) === (EDGE_LINES[2] - 1) * ROW_H,
    'count=' + i3.count + ' info=' + i3.info + ' flash=' + JSON.stringify(i3.flash)
  );

  const i4 = await tapEdge();
  note('edge state after 4th click', i4);
  check(
    'I4 第四次点绕回第 1 处（循环跳转，不会走到不存在的 4/3）',
    i4.count === '1/3' && i4.info.indexOf('multi.py:' + EDGE_LINES[0]) >= 0,
    'count=' + i4.count + ' info=' + i4.info
  );

  // ---- 右下角步进器：‹ › 手动前后走，位置与点线循环共用同一个口径 ----
  const iNextBox = await focusElement(cdp, 'callsite-next');
  note('stepper next box', iNextBox);
  await realClick(cdp, iNextBox.x, iNextBox.y);
  await sleep(300);
  const i5a = await evalJs(cdp, 'window.__t.edgeState()');
  check(
    'I5 步进器 › 从第 1 处走到第 2 处',
    i5a.count === '2/3' && i5a.info.indexOf('multi.py:' + EDGE_LINES[1]) >= 0,
    'count=' + i5a.count + ' info=' + i5a.info
  );
  const iPrevBox = await focusElement(cdp, 'callsite-prev');
  await realClick(cdp, iPrevBox.x, iPrevBox.y);
  await sleep(300);
  const i5b = await evalJs(cdp, 'window.__t.edgeState()');
  check(
    'I5 步进器 ‹ 从第 2 处回到第 1 处',
    i5b.count === '1/3' && i5b.info.indexOf('multi.py:' + EDGE_LINES[0]) >= 0,
    'count=' + i5b.count + ' info=' + i5b.info
  );

  // ---- hover：线上手型 + 提示「有几处调用、第一处在哪一行」 ----
  const i6Probe = (await iEdgeProbe(0.5)) || iPt;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(i6Probe.x) + 2,
    y: Math.round(i6Probe.y) + 1,
    button: 'none',
    buttons: 0,
    clickCount: 0,
  });
  await sleep(250);
  const i6 = await evalJs(cdp, 'window.__t.edgeState()');
  note('edge state on hover', i6);
  check(
    'I6 鼠标移到线上出提示：说明这根线背后有几处调用、第一处落在哪一行',
    i6.tip.indexOf(EDGE_LINES.length + ' call sites') >= 0 &&
      i6.tip.indexOf('first at line ' + EDGE_LINES[0]) >= 0,
    'tip=' + i6.tip
  );
  check(
    'I6 线上是手型光标（在告诉你这根线可以点）',
    i6.cursor === 'pointer',
    'cursor=' + i6.cursor
  );
  // 截图停在「边已选中 + hover 提示还在」这一帧：I7 的 ✕ 清空之后再截就什么都看不到了，人审靠这张图
  await shot(cdp, '11-edge-callsite.png');

  // ---- ✕ 清空：整条链路上的痕迹一起消失 ----
  const iClearBox = await focusElement(cdp, 'callsite-clear');
  await realClick(cdp, iClearBox.x, iClearBox.y);
  await sleep(300);
  const i7 = await evalJs(cdp, 'window.__t.edgeState()');
  note('edge state after clear', i7);
  check(
    'I7 ✕ 清掉之后步进器、底栏文本、三处打点全部消失',
    !i7.stepper && i7.count === '' && i7.info === '' && (i7.marks || []).length === 0,
    JSON.stringify({
      stepper: i7.stepper,
      count: i7.count,
      info: i7.info,
      marks: (i7.marks || []).length,
    })
  );

  // ---- I8：只有一处调用的线（N=1）—— 代码区一个标记都不铺 ----
  // utils.py::load_config 只在第 54 行调了一次 parse_lines，图上是一根 weight=1 的聚合边。
  // 没有可循环的目标，所以打点 / 角标 / ‹ › ✕ 步进器全部不出现，定位反馈交给
  // 滚动 + 闪烁 + 底栏 file:line + 图上的高亮 —— 这一组钉的就是「不铺」这件事。
  let n1Pt = null;
  for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    const cand = await evalJs(
      cdp,
      'window.__t.edgeProbe("utils.py::load_config","utils.py::parse_lines",' + f + ')'
    );
    if (cand && cand.onEdge) {
      n1Pt = cand;
      break;
    }
  }
  check(
    'I8 单调用边 load_config→parse_lines 也画出来了，线上取到命中点',
    !!n1Pt,
    n1Pt ? 'x=' + n1Pt.x.toFixed(1) + ' y=' + n1Pt.y.toFixed(1) + ' len=' + n1Pt.len : 'no'
  );
  if (!n1Pt) throw new Error('single-call edge not hittable: utils.py::load_config -> utils.py::parse_lines');
  await realClick(cdp, n1Pt.x, n1Pt.y);
  await sleep(300);
  const i8 = await evalJs(cdp, 'window.__t.edgeState()');
  note('edge state on the N=1 edge', i8);
  check(
    'I8 N=1 的线：步进器和标记（打点/角标/计数）一个都不出现',
    i8.stepper === false && i8.count === '' && (i8.marks || []).length === 0 && !i8.chip,
    JSON.stringify({ stepper: i8.stepper, count: i8.count, marks: (i8.marks || []).length, chip: i8.chip })
  );
  // 窗口化渲染：跳到第 54 行之后 code-line-1 早就不在渲染区间里了，所以「切到 utils.py」这件事
  // 要用第 54 行自己渲染出来且写着 parse_lines 来证，不能看首行文本
  const i8Line = await evalJs(cdp, 'window.__t.lineVisible(54)');
  check(
    'I8 N=1 的线照样定位：代码区切到 utils.py 第 54 行，闪烁正好压在那一行',
    !!i8Line.rendered &&
      !!i8Line.fullyVisible &&
      (i8Line.text || '').indexOf('parse_lines') >= 0 &&
      !!i8.flash &&
      parseInt(i8.flash.top, 10) === (54 - 1) * ROW_H,
    'line=' + JSON.stringify(i8Line) + ' flash=' + JSON.stringify(i8.flash)
  );
  check(
    'I8 N=1 的线底栏只写 file:line，不带 1/1 这种次数',
    i8.info.indexOf('utils.py:54') >= 0 && i8.info.indexOf('/') < 0,
    'info=' + i8.info
  );
  // 收尾：点图上的 parse_lines 节点清掉边高亮，别把状态留给后面的组。
  // 这里不用「点代码正文行」：刚滚过去定位，滚动动画可能还没停，量到的坐标会落到别的行上，
  // 万一命中那一行的调用 token 反而会重新选中同一根边（假失败 / 假通过都可能）。
  const n1Node = await evalJs(cdp, 'window.__t.findNode("utils.py::parse_lines")');
  if (!n1Node) throw new Error('graph node not found for clearing the N=1 edge: utils.py::parse_lines');
  await realClick(cdp, n1Node.x, n1Node.y);
  await sleep(300);
  const i8Clear = await evalJs(cdp, 'window.__t.edgeState()');
  check(
    'I8 点图上的节点就清掉这根单调用线的痕迹（一次只有一个焦点）',
    i8Clear.info === '' && !i8Clear.stepper && !i8Clear.chip && (i8Clear.marks || []).length === 0,
    JSON.stringify({ info: i8Clear.info, stepper: i8Clear.stepper, marks: (i8Clear.marks || []).length })
  );

  check(
    'I9 点线/循环/步进/hover/清空/单调用线全程零网络上行（这条功能只动本地状态）',
    netRequests.size === reqsBeforeEdge,
    'before=' + reqsBeforeEdge + ' after=' + netRequests.size
  );

  // ---- F：注入进 <head> 的图标必须在真浏览器 + 真 CSP 下真的能加载 ----
  // headless Chrome 不抓 <link rel="icon">（标签页图标属于浏览器 UI，不在无头渲染路径上），
  // 所以 E1-E8 的请求集里天然没有 /icon.svg。这里用 <img> 把每个注入 href 主动拉一遍：
  // 请求同样进 netRequests，于是 E1/E2/E4/E5 顺带覆盖图标 —— 同源、GET、200、且是 dist 真文件；
  // 解码成功则同时证明 CSP img-src 与静态服务的 MIME 都没挡它。
  const iconProbe = await evalJs(
    cdp,
    '(async function () {' +
      'var links = Array.prototype.slice.call(document.querySelectorAll("link[href]"))' +
      '.filter(function (l) { return (l.rel || "").indexOf("icon") > -1; })' +
      '.map(function (l) { return l.getAttribute("href"); });' +
      'var results = [];' +
      'for (var i = 0; i < links.length; i++) {' +
      'var href = links[i];' +
      'var ok = await new Promise(function (resolve) {' +
      'var img = new Image();' +
      'img.onload = function () { resolve(img.naturalWidth > 0 && img.naturalHeight > 0); };' +
      'img.onerror = function () { resolve(false); };' +
      'img.src = href;' +
      '});' +
      'results.push({ href: href, loaded: ok });' +
      '}' +
      'return { links: links, results: results };' +
      '})()',
    true,
  );
  note('icon link probe', iconProbe);
  check(
    'F1 <head> 里真有注入的四个图标 link（svg 主档 + ico 兜底 + 192 + apple-touch）',
    JSON.stringify(iconProbe.links) ===
      JSON.stringify(['/icon.svg', '/favicon.ico', '/icon-192.png', '/apple-touch-icon.png']),
    JSON.stringify(iconProbe.links),
  );
  const iconBroken = (iconProbe.results || []).filter((r) => !r.loaded);
  check(
    'F2 每个注入 href 都能当 <img> 解码（同源 + CSP img-src + MIME 全对）',
    iconBroken.length === 0,
    iconBroken.map((r) => r.href).join(', ') || 'ok',
  );

  // ---- G：反馈面板 —— 页面上唯一「往外搬信息」的功能，它的对外动作只有 href ----
  // 必须排在 E 组之前：G 期间真实发生的任何请求都会被 E1-E8 一并审计（包括「一个都没有」）。
  // 两枚链接一律只读 getAttribute('href')，**绝不点击** —— 一点就交给外部协议处理器或触发
  // 跨源导航，整个 run 会挂在那里，把 E1 打红，还留下一个对话框害掉后面的每一步。
  const contact = contactContract();
  // 先把范围切到「全部」：诊断块报的是全图计数，而图面板只渲染当前范围的子集。
  // 这一步必须在打开面板之前做完：面板是一层全屏遮罩，开着它点不到顶栏。
  await clickTestId(cdp, 'scope-all');
  // 布局完成后 DOM 计数才稳定：等它，别赌一个固定 sleep
  const pageCounts = await poll(
    cdp,
    'window.__t.stats()',
    (s) => s && s.nodes > 0 && s.edges > 0,
    10000,
    'G4 page counts after scope=all',
  ).then((r) => r.value);
  const chipCount = await evalJs(
    cdp,
    '(function () {' +
      'var els = Array.prototype.slice.call(document.querySelectorAll(\'[data-testid^="chip-"]\'));' +
      'var n = 0;' +
      'for (var i = 0; i < els.length; i++) {' +
      'var t = els[i].getAttribute(\'data-testid\');' +
      'if (t.indexOf(\'chip-remove-\') === 0) continue;' +
      'if (t.indexOf(\'chip-scroll-\') === 0) continue;' +
      'if (t.indexOf(\'chip-tooltip-\') === 0) continue;' +
      'n += 1;' +
      '}' +
      'return n;' +
      '})()',
  );
  // 黄条是「有告警」在页面上的唯一可见形态（TopBar 只在 warnings.length > 0 时渲染它）：
  // 拿它当告警计数的对端证据，比解析它的文案可靠 —— 文案是给人读的，不是数字。
  const warnBarVisible = await evalJs(cdp, '!!window.__t.byId("topbar-warnings")');
  const reqsBeforeFeedback = netRequests.size;

  await clickTestId(cdp, 'topbar-feedback');
  // 就绪判据用「元素存在」，不用「诊断文本以 build= 开头」：残留的草稿同样满足后者，
  // 而残留草稿正是这个面板被 CI 抓住过的那个 bug。
  const openedG1 = await poll(
    cdp,
    '!!window.__t.byId("feedback-dialog")',
    (v) => v === true,
    5000,
    'G1 feedback dialog',
  )
    .then(() => true)
    .catch(() => false);
  const fb = openedG1
    ? await evalJs(
        cdp,
        '(function () {' +
          'var d = window.__t.byId("feedback-dialog");' +
          'if (!d) return null;' +
          'var box = window.__t.byId("feedback-diag");' +
          'var anchors = Array.prototype.slice.call(d.querySelectorAll("a")).map(function (a) {' +
          'return {' +
          'tid: a.getAttribute("data-testid"),' +
          'href: a.getAttribute("href"),' +
          'target: a.getAttribute("target"),' +
          'rel: a.getAttribute("rel")' +
          '};' +
          '});' +
          'var em = window.__t.byId("feedback-email");' +
          'return {' +
          'diag: box ? String(box.value) : null,' +
          'anchors: anchors,' +
          'lis: d.querySelectorAll("li").length,' +
          'email: em ? (em.textContent || "").trim() : null,' +
          'text: (d.textContent || "").replace(/\\s+/g, " ").trim()' +
          '};' +
          '})()',
      )
    : null;
  // 面板还必须真的「浮在最上面」：RNW 的 View 基础样式带 z-index:0，每一个 View 都是
  // 一个层叠上下文，遮罩一旦被埋住，DOM、坐标、诊断文本全都正常，截图里却看不见面板，
  // 点关闭会点到图上 —— G6 第一次跑红抓到的正是这个。所以点之前先断言「关闭按钮中心
  // 这个点上，最上面的元素就是它自己」。
  const closeHit = fb
    ? await evalJs(
        cdp,
        '(function () {' +
          'var c = window.__t.byId("feedback-close");' +
          'if (!c) return null;' +
          'var r = c.getBoundingClientRect();' +
          'var x = r.left + r.width / 2;' +
          'var y = r.top + r.height / 2;' +
          'var e = document.elementFromPoint(x, y);' +
          'return {' +
          'x: Math.round(x),' +
          'y: Math.round(y),' +
          'hit: e ? e.tagName + "#" + (e.getAttribute("data-testid") || e.id || "") : "none",' +
          'inside: !!(e && (e === c || c.contains(e)))' +
          '};' +
          '})()',
      )
    : null;
  await shot(cdp, '07-feedback-panel.png');
  // 命中测试没过就不点：那点坐标落在图上，会白改一次选中状态，红灯也说不清是谁的错
  const closedG6 =
    closeHit && closeHit.inside
      ? await clickTestId(cdp, 'feedback-close')
          .then(() =>
            poll(
              cdp,
              '!window.__t.byId("feedback-dialog")',
              (v) => v === true,
              5000,
              'G6 feedback dialog closed',
            )
              .then(() => true)
              .catch(() => false),
          )
          .catch(() => false)
      : false;

  const fbLines = fb && fb.diag ? String(fb.diag).split('\n') : [];
  const fbFields = {};
  fbLines.forEach((l) => {
    const eq = l.indexOf('=');
    if (eq > 0) fbFields[l.slice(0, eq)] = l.slice(eq + 1);
  });
  const entryHash = (/entry-([0-9a-f]{8,})\.js/.exec(expectIndex.entry || '') || [])[1] || '';
  const issuesAnchor = fb ? fb.anchors.filter((a) => a.tid === 'feedback-issues-link')[0] : null;
  const mailAnchor = fb ? fb.anchors.filter((a) => a.tid === 'feedback-mail-link')[0] : null;
  const noRawSpace = (h) => typeof h === 'string' && h === h.trim() && !/\s/.test(h);
  const wantAnchors = contact.alias ? 2 : 1;

  check('G1 点顶栏 Feedback 真的开出了面板（就绪判据=元素存在，不是文本前缀）', openedG1 && !!fb, 'opened=' + openedG1 + ' read=' + !!fb);
  check(
    'G2 开→关整个来回 netRequests 一个都没多（打开反馈面板不发出任何东西）',
    netRequests.size === reqsBeforeFeedback,
    'before=' + reqsBeforeFeedback + ' after=' + netRequests.size,
  );
  check(
    'G3 诊断块恰好 ' + contact.fieldNames.length + ' 行、第 i 行是第 i 个白名单字段、build 钉在被测字节上',
    fbLines.length === contact.fieldNames.length &&
      fbLines.every((l, i) => l.indexOf(contact.fieldNames[i] + '=') === 0) &&
      fbFields.build === entryHash.slice(0, 8),
    'lines=' + JSON.stringify(fbLines).slice(0, 420) + ' build=' + fbFields.build + ' expect=' + entryHash.slice(0, 8),
  );
  check(
    'G4 诊断计数与页面上真实渲染的数字自洽（不新立基线），persisted 只断言取值域',
    Number(fbFields.files) === chipCount &&
      Number(fbFields.funcs) === pageCounts.nodes &&
      Number(fbFields.edges) === pageCounts.edges &&
      pageCounts.nodes > 0 &&
      Number(fbFields.unresolved) >= 0 &&
      (Number(fbFields.warnings) > 0) === warnBarVisible &&
      ['yes', 'no', 'unknown'].indexOf(fbFields.persisted) >= 0,
    'diag=' +
      [fbFields.files, fbFields.funcs, fbFields.edges, fbFields.unresolved, fbFields.warnings, fbFields.persisted].join('/') +
      ' page=' +
      [chipCount, pageCounts.nodes, pageCounts.edges, '?', 'bar=' + warnBarVisible].join('/'),
  );
  check(
    'G5 面板里的 <a> 数 == 门控期望(' + wantAnchors + ')、零 <li>、Issues 锚点 href 形状正确' +
      (contact.alias ? '、mailto 指向门控常量' : '、门控关闭时零邮件痕迹'),
    !!fb &&
      fb.anchors.length === wantAnchors &&
      fb.lis === 0 &&
      !!issuesAnchor &&
      issuesAnchor.target === '_blank' &&
      issuesAnchor.rel === 'noopener noreferrer' &&
      issuesAnchor.href.indexOf(contact.issuesUrl + '?title=') === 0 &&
      issuesAnchor.href.indexOf('&body=') > 0 &&
      noRawSpace(issuesAnchor.href) &&
      (contact.alias
        ? !!mailAnchor &&
          mailAnchor.href.indexOf('mailto:' + contact.alias + '?') === 0 &&
          !mailAnchor.target &&
          !mailAnchor.rel &&
          noRawSpace(mailAnchor.href) &&
          fb.email === contact.alias
        : !mailAnchor && fb.email === null && fb.text.indexOf('@') < 0),
    'anchors=' +
      (fb ? JSON.stringify(fb.anchors.map((a) => [a.tid, a.target, a.rel])) : 'null') +
      ' lis=' + (fb ? fb.lis : 'null') +
      ' email=' + (fb ? fb.email : 'null') +
      ' alias=' + contact.alias +
      ' hrefHead=' + (issuesAnchor ? String(issuesAnchor.href).slice(0, 90) : 'null'),
  );
  check(
    'G6 面板浮在最上面（关闭按钮中心命中自己）、点 feedback-close 后面板从 DOM 消失',
    !!closeHit && closeHit.inside === true && closedG6 === true,
    'hit=' + (closeHit ? closeHit.hit + '@' + closeHit.x + ',' + closeHit.y : 'null') + ' closed=' + closedG6,
  );

  // ================= H：6 套可切换主题 —— CSS 变量在真浏览器里切得动、也留得住 =================
  // 切主题 = 重写 <html> 上的 --cm-* 变量（外加 style.colorScheme 与 theme-color meta）。
  // React 不重渲染、浏览器不发请求，所以这里断言的是「计算后的色值真的变了」和
  // 「请求总数一个都没多」，而不是「某个组件重新画过」。H4 盯的是整套方案的命门：
  // 图节点的 fill 是 var(--cm-node-fill) 这种写在 SVG 表现属性上的引用，真浏览器认不认。
  const dfltTheme = THEME.palettes[THEME.defaultId];
  const lightTheme = THEME.palettes['github-light'];
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 'rgb(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ') + ')';
  };
  const squeeze = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  const varsEqual = (state, palette) =>
    !!state &&
    Object.keys(palette.vars).length === state.varCount &&
    Object.keys(palette.vars).every((k) => state.vars[k] === palette.vars[k]);
  const THEME_STATE_EXPR = 'window.__t.themeState(' + JSON.stringify(THEME.prefKey) + ')';
  const readThemeState = () => evalJs(cdp, THEME_STATE_EXPR);
  const themeDump = (s) =>
    s === null || s === undefined
      ? 'null'
      : 'vars=' + s.varCount + ' bg=' + s.vars['--cm-bg'] + ' rootBg=' + s.rootBg +
        ' meta=' + s.metaContent + 'x' + s.metaCount + ' scheme=' + s.colorSchemeComputed +
        ' pref=' + JSON.stringify(s.pref) + (s.prefErr ? ' prefErr=' + s.prefErr : '') +
        ' shell=' + JSON.stringify(s.shellStyle);
  const openThemePanel = async () => {
    if (await evalJs(cdp, 'window.__t.byId("theme-panel") ? 1 : 0')) return true;
    await clickTestId(cdp, 'topbar-theme');
    return poll(cdp, 'window.__t.byId("theme-panel") ? 1 : 0', (v) => v === 1, 4000, 'theme panel open')
      .then(() => true)
      .catch(() => false);
  };
  const pickTheme = async (id) => {
    const opened = await openThemePanel();
    if (!opened) return null;
    return clickTestId(cdp, 'theme-option-' + id)
      .then(() =>
        poll(cdp, THEME_STATE_EXPR, (s) => s.vars['--cm-bg'] === THEME.palettes[id].bg, 6000, 'theme ' + id + ' applied')
          .then((r) => r.value)
          .catch(() => null),
      )
      .catch(() => null);
  };

  // ---- H1 首访：profile 每次都是新建的，所以「此刻没有这个键」== 「第一次访问」 ----
  // 壳层 <style> 是 bundle 执行之前唯一还能动底色的东西（CSP 的 script-src 'self' 禁内联脚本），
  // 它必须与默认主题同字面值，否则首帧是一帧白屏而不是默认深色。
  const h1 = await readThemeState();
  check(
    'H1 首访 = 默认主题：' + THEME.varCount + ' 条变量逐条 == 源码调色板，meta 与壳层底色同字面 hex，localStorage 无偏好键',
    varsEqual(h1, dfltTheme) &&
      h1.metaContent === dfltTheme.bg &&
      h1.metaCount === 1 &&
      h1.colorSchemeComputed === dfltTheme.scheme &&
      h1.shellStyle === THEME.shellStyle &&
      h1.rootBg === hexToRgb(dfltTheme.bg) &&
      h1.pref === null &&
      h1.prefErr === null,
    themeDump(h1),
  );

  // ---- H2 面板：开得到、在最上面、六行齐、预览块是「别的主题」的字面色 ----
  const panelOpenH2 = await openThemePanel();
  const h2 = panelOpenH2 ? await evalJs(cdp, 'window.__t.themePanel()') : null;
  const h2hit = panelOpenH2 ? await evalJs(cdp, 'window.__t.topmostInPanel("theme-option-' + THEME.ids[1] + '")') : null;
  await shot(cdp, '08-theme-panel.png');
  const swatchBlob = h2 ? squeeze(h2.swatchCss) : '';
  const lightBgRgbSq = squeeze(hexToRgb(lightTheme.bg));
  const h2Cond = {
    open: !!panelOpenH2,
    panel: !!h2,
    // 页面上拿到的是 data-testid（带 theme-option- 前缀），契约里的 ids 是裸 id，比之前要补前缀
    rows: !!h2 && JSON.stringify(h2.rows) === JSON.stringify(THEME.ids.map((id) => 'theme-option-' + id)) &&
      h2.rows.length === THEME.ids.length,
    labels: !!h2 && THEME.ids.every((id, i) => String(h2.labels[i]).indexOf(THEME.palettes[id].label) >= 0),
    tick: !!h2 && h2.checked.length === 1 && h2.checked[0] === 'theme-option-' + THEME.defaultId,
    aria: !!h2 && h2.aria.filter((a) => String(a).endsWith('(current)')).length === 1,
    noVar: swatchBlob.indexOf('var(') < 0,
    // 六行里必须出现「别的主题」的字面色，否则预览块其实是从 --cm-* 取的（六行会长得一模一样）
    otherTheme: swatchBlob.indexOf(lightBgRgbSq) >= 0,
    topmost: !!h2hit && h2hit.insidePanel === true,
  };
  check(
    'H2 Theme 面板点得开、浮在最上面、六行按 THEME_ORDER：预览块是各主题字面 rgb（零 var(），只有当前项打勾',
    Object.keys(h2Cond).every((k) => h2Cond[k] === true),
    'failed=[' + Object.keys(h2Cond).filter((k) => h2Cond[k] !== true).join(',') + ']' +
      ' rows=' + JSON.stringify(h2 && h2.rows) +
      ' checked=' + JSON.stringify(h2 && h2.checked) +
      ' labels=' + JSON.stringify(h2 && h2.labels) +
      ' aria=' + JSON.stringify(h2 && h2.aria) +
      ' swatchLen=' + swatchBlob.length +
      ' wantRgb=' + lightBgRgbSq +
      ' swatchHead=' + swatchBlob.slice(0, 120) +
      ' hit=' + (h2hit ? h2hit.hit + '@' + h2hit.x + ',' + h2hit.y : 'null'),
  );

  // ---- H3 切到 GitHub Light：五处同时变亮，而且一个请求都没多 ----
  const reqsBeforeSwitch = netRequests.size;
  const h3 = await pickTheme('github-light');
  const panelClosedH3 = await evalJs(cdp, 'window.__t.byId("theme-panel") ? 1 : 0');
  check(
    'H3 切到 GitHub Light：<html> 变量 / app-root 计算背景 / theme-color / color-scheme / localStorage 五处同时变亮，面板自动关，请求总数一个都没多',
    varsEqual(h3, lightTheme) &&
      h3.rootBg === hexToRgb(lightTheme.bg) &&
      h3.metaContent === lightTheme.bg &&
      h3.metaCount === 1 &&
      h3.colorSchemeInline === lightTheme.scheme &&
      h3.colorSchemeComputed === 'light' &&
      h3.pref === lightTheme.id &&
      panelClosedH3 === 0 &&
      netRequests.size === reqsBeforeSwitch,
    themeDump(h3) + ' reqs=' + reqsBeforeSwitch + '->' + netRequests.size + ' panelClosed=' + (panelClosedH3 === 0),
  );

  // ---- H4 命门：fill="var(--cm-node-fill)" 写在 SVG 表现属性上，真浏览器解得出 rgb ----
  // 亮色主题的 nodeFill 与深色主题的 nodeFill 是两个不同的 rgb，所以「命中当前调色板」
  // 同时证明了 var() 被解析、而且跟着刚切的主题走。
  const lightRgbSet = new Set(
    Object.keys(lightTheme.vars)
      .filter((k) => lightTheme.vars[k].charAt(0) === '#')
      .map((k) => hexToRgb(lightTheme.vars[k])),
  );
  const nodeCountH4 = await evalJs(cdp, 'window.__t.allByPrefix("graph-node-").length');
  check(
    'H4 图节点的 fill 计算值是真 rgb（var() 没漏进 computed style），且等于刚切过去的亮色调色板里的某个色',
    nodeCountH4 > 0 &&
      !!h3 &&
      /^rgb/.test(String(h3.nodeFillComputed)) &&
      String(h3.nodeFillComputed).indexOf('var(') < 0 &&
      lightRgbSet.has(h3.nodeFillComputed),
    'nodes=' + nodeCountH4 + ' attr=' + (h3 ? h3.nodeFillAttr : 'null') + ' computed=' + (h3 ? h3.nodeFillComputed : 'null'),
  );
  // 留一张亮色截图：计算值对不代表人眼看着也对（对比度靠 theme.test.ts 的门禁，观感靠这张图）
  await shot(cdp, '09-theme-light.png');

  // ---- H5 刷新后不点任何东西仍是亮色：initTheme() 在入口模块作用域就把主题装好 ----
  const cspBeforeReload = ((await evalJs(cdp, 'window.__cspViolations || []')) || []).length;
  await evalJs(cdp, 'window.__beforeReload = 1');
  await cdp.send('Page.reload', {});
  await poll(
    cdp,
    '(window.__beforeReload ? 0 : (document.querySelector(\'[data-testid="app-root"]\') || document.querySelector(\'[testid="app-root"]\') ? 1 : 0))',
    (v) => v === 1,
    45000,
    'H5 fresh document + app-root',
  );
  await evalJs(cdp, HARNESS);
  const h5 = await readThemeState();
  const h5viol = (await evalJs(cdp, 'window.__cspViolations || []')) || [];
  check(
    'H5 刷新后什么都没点就还是 GitHub Light（偏好读得到、首帧就装载），新文档零 CSP 违规',
    varsEqual(h5, lightTheme) &&
      h5.rootBg === hexToRgb(lightTheme.bg) &&
      h5.metaContent === lightTheme.bg &&
      h5.colorSchemeComputed === lightTheme.scheme &&
      h5.pref === lightTheme.id &&
      h5viol.length === 0,
    themeDump(h5) + ' violations=' + JSON.stringify(h5viol).slice(0, 240),
  );

  // ---- H6 切回默认：颜色/meta/color-scheme 复原，偏好写回默认值 ----
  const h6 = await pickTheme(THEME.defaultId);
  await shot(cdp, '10-theme-default-restored.png');
  check(
    'H6 切回 ' + THEME.defaultId + '：变量 / 计算背景 / meta / color-scheme 全部复原成源码默认值，偏好也写回默认',
    varsEqual(h6, dfltTheme) &&
      h6.rootBg === hexToRgb(dfltTheme.bg) &&
      h6.metaContent === dfltTheme.bg &&
      h6.colorSchemeInline === dfltTheme.scheme &&
      h6.colorSchemeComputed === dfltTheme.scheme &&
      h6.pref === dfltTheme.id,
    themeDump(h6),
  );

  // ================= ACCEPTANCE 4: 承诺面 —— 浏览器里真实发生的一切 =================
  const httpReqs = [...netRequests.values()].filter((r) => /^https?:/i.test(r.url));
  const selfOrigin = new URL(APP_URL).origin;
  const originOf = (u) => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  };
  const pathnameOf = (u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  };
  note(
    'browser requests',
    httpReqs.map((r) => r.method + ' ' + r.url + ' -> ' + (r.status || 'FAILED:' + (r.failed || '?'))),
  );
  report.network = httpReqs;
  const cross = httpReqs.filter((r) => originOf(r.url) !== selfOrigin);
  check('E1 每一个浏览器请求都是同源', cross.length === 0, cross.map((r) => r.url).join(', ') || '总请求数=' + httpReqs.length);
  const nonGet = httpReqs.filter((r) => r.method !== 'GET');
  check('E2 每一个浏览器请求都是 GET', nonGet.length === 0, nonGet.map((r) => r.method + ' ' + r.url).join(', ') || httpReqs.length + ' 个全 GET');
  const bodies = httpReqs.filter((r) => r.hasPostData || r.postDataBytes > 0);
  check('E3 零请求体（没有任何数据被送出浏览器）', bodies.length === 0, bodies.map((r) => r.method + ' ' + r.url + ' ' + r.postDataBytes + 'B').join(', ') || '0');
  const bad = httpReqs.filter((r) => r.status && r.status >= 400);
  check('E4 没有 4xx/5xx 响应', bad.length === 0, bad.map((r) => r.status + ' ' + r.url).join(', ') || '0');
  const notAsset = httpReqs.filter((r) => r.status === 200 && !distFileFor(pathnameOf(r.url)));
  check(
    'E5 每个 200 响应都对应 dist/ 里真实存在的文件（被测字节 == 上线字节）',
    notAsset.length === 0,
    notAsset.map((r) => pathnameOf(r.url)).join(', ') || 'ok',
  );
  const liveEntry = await evalJs(
    cdp,
    'Array.prototype.slice.call(document.getElementsByTagName("script")).map(function(s){return s.getAttribute("src")}).filter(function(u){return u && u.indexOf("/entry-") > -1})[0] || null',
  );
  check('E6 页面里执行的入口 JS 就是 dist 的那个文件', liveEntry === expectIndex.entry, 'live=' + liveEntry + ' dist=' + expectIndex.entry);
  const tokens = userContentTokens();
  const leaks = [];
  for (const r of httpReqs) {
    if (distFileFor(pathnameOf(r.url))) continue; // 真资产路径本身不算泄露
    for (const t of tokens) {
      if (r.url.indexOf(t) >= 0 || r.url.indexOf(encodeURIComponent(t)) >= 0) leaks.push(t + ' -> ' + r.url);
    }
  }
  check(
    'E7 URL 里没有用户内容（文件名/函数名/代码片段）',
    leaks.length === 0,
    leaks.slice(0, 5).join(' | ') || tokens.length + ' 个标记 x ' + httpReqs.length + ' 个请求，零命中',
  );
  // H5 会刷新页面，而计数器是 addScriptToEvaluateOnNewDocument 装的 —— 新文档从 0 开始，
  // 所以刷新前那份必须单独取一次，两个文档都为零才算「生产 CSP 下零违规」。
  const cspViolations = (await evalJs(cdp, 'window.__cspViolations || []')) || [];
  check(
    'E8 生产 CSP 下零违规（刷新前 + 刷新后两个文档都算）',
    cspViolations.length === 0 && cspBeforeReload === 0,
    JSON.stringify(cspViolations).slice(0, 600) + ' preReload=' + cspBeforeReload,
  );

  // note() 只是打印；真正的错误要变成一条断言，否则 CI 里没人会去看日志
  const consoleErrors = console_.filter((c) => c.indexOf('error:') === 0 || c.indexOf('log:') === 0);
  note('console errors/warnings', console_.slice(0, 30));
  note('page exceptions', exceptions.slice(0, 10));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | ') || '0');
  check('no uncaught page exceptions', exceptions.length === 0, String(exceptions.length));
}

let EXIT = 0;
const REPORT_PATH = path.join(TMP, 'codemap-verify-report.json');

async function run() {
  try {
    await main();
  } catch (e) {
    report.fatal = String((e && e.stack) || e);
    console.log('[FATAL] ' + report.fatal);
    EXIT = 1;
  } finally {
    if (globalThis.CDP) { try { await globalThis.CDP.send('Browser.close'); } catch { /* ignore */ } }
    const h = globalThis.PROC;
    if (h) { try { h.chrome.kill('SIGKILL'); } catch { /* ignore */ } }
    const srv = globalThis.SRV;
    if (srv && srv.server) { try { srv.server.close(); } catch { /* ignore */ } }
    await sleep(1200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
    const failed = report.checks.filter((c) => !c.pass);
    report.summary = {
      total: report.checks.length,
      passed: report.checks.length - failed.length,
      failed: failed.map((c) => c.name),
    };
    report.finishedAt = new Date().toISOString();
    report.shotsDir = SHOTS;
    try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch { /* ignore */ }
    console.log('\n==== SUMMARY ====');
    console.log(JSON.stringify(report.summary, null, 2));
    console.log('report: ' + REPORT_PATH);
    if (report.summary.failed.length > 0) EXIT = EXIT || 2;
    process.exit(EXIT);
  }
}

run();


