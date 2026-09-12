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
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const APP_PORT = Number(process.env.CODEMAP_PORT || 8099);
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const PORT = Number(process.env.CODEMAP_CDP_PORT || 9333);
const TMP = os.tmpdir();
const PROFILE = path.join(TMP, 'cdp-codemap-profile');
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

/** 托管 dist/；端口被占用时假定已有服务在跑，直接复用。 */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(DIST + path.sep) && file !== DIST) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          // Chrome 会自己去要 /favicon.ico，dist 里没有；回 204 免得污染控制台错误列表
          if (p === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
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

/** 复用别人的服务有风险：先确认这个端口上跑的确实是本应用。 */
async function probeAppUrl() {
  let res;
  try {
    res = await fetch(APP_URL, { cache: 'no-store' });
  } catch (e) {
    throw new Error('访问 ' + APP_URL + ' 失败：' + e.message + '（端口 ' + APP_PORT + ' 上没有可用服务）');
  }
  if (!res.ok) throw new Error(APP_URL + ' 返回 HTTP ' + res.status);
  const html = await res.text();
  if (html.indexOf('<title>code-map</title>') < 0) {
    throw new Error(
      APP_URL + ' 返回的内容不是本应用（端口 ' + APP_PORT + ' 可能被别的服务占用），用 CODEMAP_PORT 换个端口再跑',
    );
  }
  return html.length;
}

const FIXTURES = ['main.py', 'shapes.py', 'utils.py'];
const TARGET_A = { id: 'shapes.py::Shape.area', defLine: 14, label: 'Shape.area' };
const TARGET_B = { id: 'utils.py::Registry.add', defLine: 95, label: 'Registry.add' };
const ROW_H = 20;

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
    var tabs = allByPrefix('file-tab-');
    var out = [];
    var active = null;
    for (var i = 0; i < tabs.length; i++) {
      var cs = getComputedStyle(tabs[i]);
      var p = tid(tabs[i]).replace('file-tab-', '');
      out.push(p);
      if (cs.borderBottomWidth === '2px' && cs.borderBottomColor !== 'rgb(220, 60, 60)') active = p;
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
  window.__t = {
    byId: byId, allByPrefix: allByPrefix, tid: tid, txt: txt, rect: rect,
    findNode: findNode, sample: sample, renderedLines: renderedLines,
    lineVisible: lineVisible, centerOf: centerOf, ensureCenter: ensureCenter,
    tokenInfo: tokenInfo, drop: drop, probe: probe,
    stats: stats, activeTab: activeTab, scrollEl: scrollEl
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

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/index.html 不存在，请先运行 npm run export 产出静态站点');
  }
  const srv = await startStaticServer();
  globalThis.SRV = srv;
  note('static server', srv.reused ? 'reused :' + APP_PORT : 'started :' + APP_PORT);
  note('app url probe', APP_URL + ' html=' + (await probeAppUrl()) + 'B');

  fs.rmSync(PROFILE, { recursive: true, force: true });
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

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
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

  check('A1 active file switched to shapes.py', afterA.active.active === 'shapes.py', JSON.stringify(afterA.active));
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

  check('C1 switched to utils.py', afterC.active.active === 'utils.py', JSON.stringify(afterC.active));
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
