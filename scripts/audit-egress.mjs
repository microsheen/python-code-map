#!/usr/bin/env node
// audit-egress.mjs - guard the contact path of an app whose promise is "the page sends nothing".
//
//   node audit-egress.mjs --files=<a.js,b.jsx>[,...] [--public-address=<email>]
//        [--require-href] [--allow-token=<substr>]... [--json]
//
// Two questions, both answerable by reading the files - no browser, no build, no credentials:
//   1. Can these files make the page send something on its own?   (egress primitives)
//   2. Is every email-shaped literal in them the one address you meant to publish?
//
// Exit 0 clean, 1 at least one counted finding (a file that cannot be read counts: a guard that
// silently skipped its input is worse than a red light), 2 usage. A finding means "look at this", not
// "delete this": a deliberate exception is declared with --allow-token and then printed as
// allowed, never silenced. Email literals are printed masked (local part truncated) so this
// scanner cannot itself become the leak it is looking for.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const files = [];
const allowed = [];
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
  else if (a === '--require-href') requireHref = true;
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
    'usage: node audit-egress.mjs --files=<a,b> [--public-address=<email>] [--require-href] [--allow-token=<substr>]... [--json]'
  );
}

if (!files.length) {
  console.error('--files is required');
  usage();
  process.exit(2);
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
      const isAllowed = allowed.some((t) => t && token.includes(t));
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
