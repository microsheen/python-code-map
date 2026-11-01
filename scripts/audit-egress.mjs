#!/usr/bin/env node
// audit-egress.mjs - guard the files that could make the page send something on its own.
//
//   node audit-egress.mjs --files=<a.js,b.jsx>[,...] [--public-address=<email>]
//        [--require-href] [--allow-token=<substr>]... [--allow-egress=<file>:<substr>]... [--json]
//
// Two questions, both answerable by reading the files - no browser, no build, no credentials:
//   1. Can these files make the page send something on its own?   (egress primitives)
//   2. Is every email-shaped literal in them the one address you meant to publish?
//
// Two kinds of allowed findings, deliberately different in blast radius:
//   --allow-token=<substr>          global: applies to every scanned file. Only for a promise that
//                                   is meant to hold scanner-wide (the contact path's "no request
//                                   primitive at all").
//   --allow-egress=<file>:<substr>  file-scoped: applies only to that file (exact path as passed to
//                                   --files). This is how a module with one declared outbound point
//                                   (the pull transport's fetch) is admitted without also relaxing
//                                   the contact path. A declaration for a file that is not being
//                                   scanned is a usage error: a declaration nobody reads is worse
//                                   than none. The substr must not contain shell metacharacters
//                                   (`fetch`, not `fetch(`): npm runs a script line through `sh -c`
//                                   on Linux, where an unquoted `(` is a syntax error (exit 2), even
//                                   though cmd.exe on Windows passes it through.
//
// Exit 0 clean, 1 at least one counted finding (a file that cannot be read counts: a guard that
// silently skipped its input is worse than a red light), 2 usage. A finding means "look at this", not
// "delete this": a deliberate exception is declared and then printed as allowed, never silenced.
// Email literals are printed masked (local part truncated) so this scanner cannot itself become
// the leak it is looking for.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const files = [];
const allowed = [];
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
  else if (a.startsWith('--allow-token=')) allowed.push(a.slice(14));
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
    'usage: node audit-egress.mjs --files=<a,b> [--public-address=<email>] [--require-href] [--allow-token=<substr>]... [--allow-egress=<file>:<substr>]... [--json]'
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
      const isAllowed =
        allowed.some((t) => t && token.includes(t)) ||
        scopedAllows.some((s) => s.file === rel && token.includes(s.token));
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
