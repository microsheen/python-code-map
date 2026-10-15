#!/usr/bin/env node
/**
 * 把图标、meta 与壳层底色样式注入 dist/ 的 HTML：postexport 的第一步，跑在 polish-dist.mjs 之前。
 *
 * 为什么不用 Expo 的 web.favicon：它会拿 @expo/image-utils 把母版重新栅格化成 favicon.ico，
 * 等于在构建链里塞第二套 SVG 解释器 + 一条图像依赖。我们的 PNG/ICO 已由 scripts/build-icons.mjs
 * 用真 Chrome 从 public/icon.svg 生成并入库，public/ 整目录被 expo export 拷进 dist/，
 * 这里只负责把同源相对路径写进 <head>。
 *
 * 为什么不是 app/+html.tsx：SDK 57 的 expo-router 不再导出 Html/Head/Main/Scripts
 * （[实测] 写了就 TS2305），metro 导出的 HTML 外壳由 CLI 模板生成，用户侧没有注入点。
 * dev server（npm run web）因此拿不到这组 <link>；但浏览器本来就会自动请求 /favicon.ico，
 * 该文件在 public/ 里，所以 dev 下标签页图标同样生效，只是没有 SVG 高清档。
 *
 * 顺序很重要：本脚本先改写 HTML，polish-dist.mjs 随后对改写后的字节跑结构自检与
 * "零绝对 URL"自检 —— 注入进来的 href 也在门禁覆盖范围内，不是门禁之外的飞地。
 *
 * 幂等：以 data-codemap="icon" 为哨兵，对同一份 dist 重复运行不会叠第二组标签。
 * 失败即构建失败：每个 href 都不许带 scheme，且必须能在 dist/ 里找到对应文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SENTINEL = 'data-codemap="icon"';

/** href 一律同源相对路径：部署扫描与 polish-dist 都按整段正文找 scheme */
export const HEAD_LINKS = [
  { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' },
  { rel: 'alternate icon', href: '/favicon.ico' },
  { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
];

export const HEAD_METAS = [
  {
    name: 'description',
    content:
      'Python Code Map — parse Python in the browser with tree-sitter (WASM) and visualize the function call graph. 浏览器内真语法解析 Python，可视化函数调用关系图。',
  },
  { name: 'theme-color', content: '#0d1117' },
];

/**
 * 壳层底色：给 HTML 外壳上默认主题的背景色，消掉「白屏一闪」。
 *
 * 为什么是内联 <style> 而不是内联 <script>：上线的 CSP 是 script-src 'self'（禁内联脚本），
 * 而 style-src 带 'unsafe-inline' —— 唯一能在 bundle 执行之前动底色的手段就是这段样式。
 * 它只带默认主题的 --cm-bg 一条变量：主题切换发生在 JS 里，而 JS 一跑起来整页颜色都是它的了。
 *
 * 色值必须与 src/theme.ts 的 THEMES['github-dark'].colors.bg 同字面值，
 * 也与下面 theme-color 的 content 同值 —— 三条都由 __tests__/icons.test.ts 钉住。
 * 存了非默认主题的用户仍会先看到这一帧默认底色（到 bundle 执行为止），这是不换 CSP 的代价，
 * 记在 docs/adr/0004。
 *
 * 零绝对 URL：这段里没有 http，polish-dist.mjs 的承诺自检照样过。
 */
export const SHELL_STYLE = ':root{--cm-bg:#0d1117}html,body,#root{background-color:var(--cm-bg)}';

function fail(msg) {
  console.error('[inject-html-head] ' + msg);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

function attr(k, v) {
  return k + '="' + v + '"';
}

function buildBlock(indent) {
  const lines = [];
  for (const m of HEAD_METAS) {
    lines.push(indent + '<meta ' + attr('name', m.name) + ' ' + attr('content', m.content) + ' />');
  }
  HEAD_LINKS.forEach((l, i) => {
    const parts = [attr('rel', l.rel)];
    if (l.type) parts.push(attr('type', l.type));
    if (l.sizes) parts.push(attr('sizes', l.sizes));
    parts.push(attr('href', l.href));
    if (i === 0) parts.push(SENTINEL);
    lines.push(indent + '<link ' + parts.join(' ') + ' />');
  });
  lines.push(indent + '<style data-codemap="shell">' + SHELL_STYLE + '</style>');
  return lines.join('\n');
}

if (!fs.existsSync(DIST)) fail('dist/ 不存在，本脚本只应在 npm run export 之后运行');
const files = walk(DIST);
if (!files.length) fail('dist/ 里没有任何 HTML 文件');

for (const l of HEAD_LINKS) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(l.href))
    fail('href 带 scheme，会被部署扫描判为第三方引用：' + l.href);
  const rel = l.href.replace(/^\//, '');
  if (!fs.existsSync(path.join(DIST, rel)))
    fail('dist/ 里找不到 ' + l.href + '（public/ 是否漏了这个文件？）');
}

let injected = 0;
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(SENTINEL)) continue;
  // 缩进照抄该文件里 </head> 那一行自己的缩进：注入后 <head> 内部仍然对齐，产物 diff 好读
  const hm = before.match(/^([ \t]*)<\/head>/m);
  if (!hm) fail(file + ' 里没有行首 </head>，无法注入');
  const indent = hm[1] || '  ';
  const after = before.replace(hm[0], () => buildBlock(indent) + '\n' + hm[0]);
  fs.writeFileSync(file, after, 'utf8');
  injected++;
  console.log(
    '[inject-html-head] ' +
      path.relative(ROOT, file).split(path.sep).join('/') +
      ': 注入 ' +
      HEAD_METAS.length +
      ' 个 meta + ' +
      HEAD_LINKS.length +
      ' 个 link + 1 段壳层样式，' +
      Buffer.byteLength(before) +
      'B -> ' +
      Buffer.byteLength(after) +
      'B'
  );
}
if (!injected)
  console.log('[inject-html-head] 哨兵已存在，未重复注入（' + files.length + ' 个 HTML）');
else
  console.log(
    '[inject-html-head] OK：' + injected + '/' + files.length + ' 个 HTML 已带图标与 meta'
  );
