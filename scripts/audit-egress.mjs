#!/usr/bin/env node
// audit-egress.mjs —— 逐字扫描受审文件，抓页面自己可能发请求 / 存数据 / 越权的形状，
// 同时核对文件里每个邮箱字面量是不是那个你要公开的地址。
//
//   node audit-egress.mjs --files=<a.js,b.jsx>[,...] [--public-address=<email>]
//        [--require-href] [--allow-egress=<file>:<substr>]... [--json]
//
// 两件事都只读文件就能答，不需浏览器、不需构建、不需凭据：
//   1. 这些文件里有没有页面能自己发请求 / 存持久化数据的原语（请求形状、剪贴板、storage 等）？
//   2. 文件里每个长得像邮箱的字面量是不是那个你要公开的地址？
//
// 放行按文件，两种形状故意不同爆炸半径：
//   --allow-egress=<file>:<substr> 只限那个文件（必须精确等于 --files 里给的路径）。
//   模块里有一处声明的外发点（比如拉取传输层的 fetch）放行，不会顺带放开联系路径「没有任何请求
//   原语」那条更窄的保证。声明了一个不在扫描范围内的文件是用法错（exit 2）——没人读的声明不如
//   没有。substr 里不能含 shell 元字符（`fetch`，不要 `fetch(`）：npm 在 Linux 上把 script 交给
//   `sh -c`，未加引号的 `(` 会被当成子 shell 开头报语法错误；Windows 的 cmd.exe 却照传。
//
// 退出码：0 干净、1 至少一个 counted finding（文件读不出来也算——静默跳过的守卫比红灯更糟）、
// 2 用法错。finding 的意思是「去看一下」，不是「删掉」——刻意的例外被声明后会打印成 allowed，
// 绝不会被静默吞掉。邮箱字面量打印时会遮罩（本地部分截断），扫描器本身不能变成它在找的那个
// 泄露渠道。

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const files = [];
const scopedAllows = [];
let publicAddress = null;
let requireHref = false;
let json = false;

for (const a of argv) {
  if (a.startsWith('--files='))
    files.push(
      ...a
        .slice(8)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  else if (a.startsWith('--public-address=')) publicAddress = a.slice(17).trim().toLowerCase();
  else if (a.startsWith('--allow-egress=')) {
    const value = a.slice(15);
    const at = value.indexOf(':');
    if (at <= 0 || at === value.length - 1) {
      console.error('--allow-egress 要写成 <file>:<substr>，收到的是 ' + value);
      usage();
      process.exit(2);
    }
    scopedAllows.push({ file: value.slice(0, at), token: value.slice(at + 1) });
  } else if (a === '--require-href') requireHref = true;
  else if (a === '--json') json = true;
  else if (a === '-h' || a === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error('unknown argument: ' + a);
    usage();
    process.exit(2);
  }
}

function usage() {
  console.error(
    'usage: node audit-egress.mjs --files=<a,b> [--public-address=<email>] [--require-href] [--allow-egress=<file>:<substr>]... [--json]'
  );
}

if (!files.length) {
  console.error('--files is required');
  usage();
  process.exit(2);
}

for (const s of scopedAllows) {
  if (!files.includes(s.file)) {
    console.error(
      '--allow-egress 申报的文件不在 --files 扫描范围内：' + s.file + '（声明没人读，等于没声明）'
    );
    usage();
    process.exit(2);
  }
}

// Ordered by "how quietly this could exfiltrate": a request primitive first, then window/clipboard,
// then persistence. `<form` and `new Image(` are in here because they need no JS at all to fire.
const TOKENS = [
  ['fetch(', 'can issue a request'],
  ['XMLHttpRequest', 'can issue a request'],
  ['sendBeacon', 'can post on unload'],
  ['WebSocket', 'can hold a socket open'],
  ['EventSource', 'can hold a stream open'],
  ['new Image(', '1px-beacon shape'],
  ['<form', 'can submit without any JS'],
  ['window.open', 'can open a window without a click'],
  ['navigator.clipboard', 'can write the clipboard'],
  ['navigator.share', 'can hand data to another app'],
  ['document.cookie', 'can write cookies'],
  ['localStorage.setItem', 'persists beyond the panel'],
  ['sessionStorage.setItem', 'persists beyond the panel'],
  ['indexedDB', 'reaches into the app data store'],
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function mask(email) {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  return local.slice(0, 1) + '***' + email.slice(at);
}

const findings = [];
let hrefSeen = false;

for (const rel of files) {
  let code;
  try {
    code = readFileSync(rel, 'utf8');
  } catch (err) {
    findings.push({ file: rel, kind: 'unreadable', detail: err.code || String(err.message) });
    continue;
  }
  const lines = code.split('\n');

  for (const [token, why] of TOKENS) {
    let from = 0;
    for (;;) {
      const i = code.indexOf(token, from);
      if (i < 0) break;
      from = i + token.length;
      const line = code.slice(0, i).split('\n').length;
      const isAllowed = scopedAllows.some((s) => s.file === rel && token.includes(s.token));
      findings.push({
        file: rel,
        kind: isAllowed ? 'allowed-egress-token' : 'egress-token',
        token,
        why,
        line,
        text: (lines[line - 1] || '').trim().slice(0, 110),
      });
    }
  }

  for (const m of code.matchAll(EMAIL_RE)) {
    const value = m[0];
    const line = code.slice(0, m.index).split('\n').length;
    if (publicAddress && value.toLowerCase() === publicAddress) continue;
    findings.push({
      file: rel,
      kind: 'email-literal',
      value: mask(value),
      line,
      text: (lines[line - 1] || '').trim().slice(0, 110),
    });
  }

  if (code.includes('href=')) hrefSeen = true;
}

if (requireHref && !hrefSeen) {
  findings.push({
    file: files.join(','),
    kind: 'no-href',
    detail:
      'the outbound path should be a link the user clicks; no href= found in any scanned file',
  });
}

const counted = findings.filter((f) => !f.kind.startsWith('allowed-'));

if (json) {
  console.log(JSON.stringify({ scanned: files, findings, counted: counted.length }, null, 2));
} else {
  console.log(
    'audit-egress: scanned ' +
      files.length +
      ' file(s)' +
      (publicAddress ? ', public address ' + mask(publicAddress) : '')
  );
  for (const f of findings) {
    const head = f.kind === 'allowed-egress-token' ? 'ALLOWED ' : 'FOUND   ';
    const what = f.token || f.value || f.kind;
    const why = f.why || f.detail || '';
    const where = f.line ? f.file + ':' + f.line : f.file;
    console.log('  ' + head + what + (why ? '  (' + why + ')' : '') + '  ' + where);
    if (f.text) console.log('           ' + f.text);
  }
  if (!findings.length) console.log('  clean: no egress primitive, no unpublished address');
  console.log(counted.length ? 'FAIL: ' + counted.length + ' finding(s)' : 'OK');
}

process.exit(counted.length ? 1 : 0);
