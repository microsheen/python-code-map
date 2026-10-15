#!/usr/bin/env node
/**
 * 构建后处理（npm run export 的 postexport 钩子）：
 *   1. 剥掉 dist/ 里所有 HTML 的注释；
 *   2. 在构建阶段就守住"上线的 HTML 字节里零绝对 URL"这条承诺；
 *   3. 打印最终 index.html 的 sha256，作为"被测字节 == 上线字节"的锚点。
 *
 * 为什么必须剥注释：Expo 的 web HTML 模板自带一行注释
 *   <!-- The `react-native-web` recommended style reset: https://necolas.github.io/... -->
 * 它不是可执行引用，但发布后的扫描（publish-static-site 技能的 check-deploy.mjs）
 * 用正文级正则扫 https?://host，会把注释里的域名算成"HTML 内第三方 URL"并让门禁变红。
 * 正确做法不是放宽扫描，而是让上线字节里真的一个都不剩 —— 见该技能不变式 1。
 *
 * 本脚本失败即构建失败：不跳过、不降级、不 continue-on-error。
 * 幂等：重复运行不改变字节。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** 整行注释优先整行删，避免留下空行 */
const COMMENT_RE = /[ \t]*<!--[\s\S]*?-->[ \t]*\n?/g;
/** 与部署扫描同一条正文级正则：任何绝对 http(s) URL 都不允许出现在 HTML 字节里 */
const ABS_URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

function fail(msg) {
  console.error('[polish-dist] ' + msg);
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

if (!fs.existsSync(DIST)) fail('dist/ 不存在，本脚本只应在 npm run export 之后运行');

const files = walk(DIST);
if (!files.length) fail('dist/ 里没有任何 HTML 文件，产物不符合预期');

let totalRemovedComments = 0;
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  const comments = before.match(COMMENT_RE) || [];
  const after = before.replace(COMMENT_RE, '');
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log('[polish-dist] ' + rel + ': 删除 ' + comments.length + ' 段注释，' + Buffer.byteLength(before) + 'B -> ' + Buffer.byteLength(after) + 'B');
    if (!/<!--/.test(after)) console.log('[polish-dist]   已确认产物中不再残留 HTML 注释');
  } else {
    console.log('[polish-dist] ' + rel + ': 无注释，字节未变');
  }
  totalRemovedComments += comments.length;
}

// ---- 结构性自检：剥注释不许把应用本体弄坏 ----
const indexPath = path.join(DIST, 'index.html');
if (!fs.existsSync(indexPath)) fail('dist/index.html 不存在');
const html = fs.readFileSync(indexPath, 'utf8');
const entryMatch = html.match(/<script[^>]+src="([^"]*\/_expo\/static\/js\/web\/entry-[0-9a-f]+\.js)"[^>]*>/);
if (!/<div id="root">/.test(html)) fail('dist/index.html 里找不到 root 元素，HTML 可能被破坏');
if (!entryMatch) fail('dist/index.html 里找不到 Metro 入口脚本标签，HTML 可能被破坏');

// ---- 承诺自检：绝对 URL 必须为零 ----
const absUrls = [...new Set(html.match(ABS_URL_RE) || [])];
if (absUrls.length) {
  fail('dist/index.html 里仍存在绝对 URL（部署扫描会计为第三方引用）：\n  ' + absUrls.join('\n  ') + '\n  处理办法：改成同源相对路径，或把该引用从产物里去掉。');
}

const sha = crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex');
console.log('[polish-dist] index.html 入口脚本: ' + entryMatch[1]);
console.log('[polish-dist] index.html sha256: ' + sha + '  (' + fs.statSync(indexPath).size + ' B)');
console.log('[polish-dist] OK：HTML 无注释、无绝对 URL，root 与入口脚本完好（共处理 ' + files.length + ' 个 HTML，删除 ' + totalRemovedComments + ' 段注释）');