# Python Code Map — Visualize Python function call graphs

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

## Demo

**👉 Try it now: <https://python-code-map.com>** — open the page, drop a few `.py` files in, and their call graph is drawn right in your browser. Nothing to install, no sign-up, no upload: all parsing happens inside your own browser.

> If that domain is unreachable from your network, the very same build is also served at <https://python-code-map.pages.dev>.

_The repository name, the npm package name and the IndexedDB database name are all still `code-map`: the first two are only identifiers, and renaming the third would cut existing users off from their stored local sessions outright._

Upload one or more `.py` files and see their function call graph in the browser — code on the left, graph on the right, and a click on either side locates the other.

- **Pure front end, zero egress**: no backend service, no accounts, no database, no third-party scripts or analytics. Your source is parsed in the browser only and never leaves this machine as part of any request — that is not a slogan but a set of assertions in the real-browser gate (every request is same-origin, every request is a GET, every request body is empty, and no URL contains your file names or code fragments).
- **Sessions live only on your own machine**: file contents are written to the browser's local IndexedDB (database `code-map` / store `session` / key `current`) and restored on reload; clicking Clear or wiping site data deletes them for good, and the server never sees them.
- **Real syntax parsing**: Python is parsed with tree-sitter (WASM), not by scanning lines with regexes — nested `def`, class methods, `async def`, decorators and relative imports are all recognized correctly.
- **Stack**: Expo SDK 57 + React Native Web + react-native-svg + dagre layout + zustand.

Three key design decisions are recorded as ADRs; read them before changing code:

- [ADR-0001 Pure front end + tree-sitter WASM, no backend / no Pyodide](docs/adr/0001-expo-rn-web-no-backend.md)
- [ADR-0002 Conservative call resolution and the reason taxonomy](docs/adr/0002-conservative-call-resolution.md)
- [ADR-0003 The feedback channel is allowed to be nothing but two hrefs](docs/adr/0003-feedback-channel-href-only.md)

_The ADRs and everything else under `docs/` are written in Chinese._

## Quick start

Node.js 18+ required (20+ recommended).

```bash
npm install          # install dependencies (needs network)
npm run web          # start the dev server and open a browser (http://localhost:8081 by default)
```

At the end of `npm install`, `postinstall` (that is, `npm run copy-wasm`) runs automatically: it syncs the two `.wasm` files from node_modules into `public/wasm/` and runs one real smoke check in Node (`Parser.init` + `Language.load` + `parse`). Seeing `[copy-wasm] 冒烟校验通过` ("smoke check passed") means the wasm ABIs do match. Those two `.wasm` files are not committed (see `.gitignore`), so **a freshly cloned repository must run `npm install` once**; `npm run web` / `npm run export` sync them again through `preweb` / `preexport`. If you installed with `--ignore-scripts`, run `npm run copy-wasm` by hand.

Then: click "Select .py Files" to upload, or drop files straight into the area on the right. The repository ships samples you can try immediately: `fixtures/main.py`, `fixtures/shapes.py`, `fixtures/utils.py`.

## Interface

```
┌──────────────────────────────────────── Top bar ─────────────────────────────────────────┐
│ Upload   file chips (each removable)   Scope: Neighborhood / This File / All   Feedback  │
│ Stats: funcs / edges / unresolved + byReason     warning bar (bad-file degradation)      │
├──────────────────────────────────────┬───────────────────────────────────────────────────┤
│  Left: code                          │  Right: call graph                                │
│  file tabs                           │  dagre layered layout (left to right)             │
│  syntax highlighting + line numbers  │  nodes colored by file, badge = unresolved count  │
│  clickable function name / ƒ marker  │  wheel zoom, drag to pan, + / − / fit view        │
└──────────────────────────────────────┴───────────────────────────────────────────────────┘
```

The divider in the middle can be dragged (the left/right ratio is clamped to 25%–75%); below 900px of window width the layout automatically stacks vertically.

## Two-way navigation (the core feature)

**Graph → code**: clicking any function node in the graph makes the left side

1. switch to the tab of the file that owns that function;
2. scroll to its `def` line;
3. cover the whole function body (`startLine..endLine`) with a highlight band and flash it once;
4. clip the graph on the right to that function's neighborhood (itself + direct callers/callees).

**Code → graph**: clicking a function in the code makes the right side

1. recompute the scoped subgraph and its layout;
2. move that node to the center of the viewport (keeping the current zoom level);
3. highlight that node and its direct call edges, and dim every other node/edge.

Clicks in the code are **semantics-aware**, not a plain "select whichever line you clicked":

- clicking a function name (`boot` in `def boot`) or the `ƒ` marker next to the line number → selects that function;
- clicking any line inside a function body → selects the **innermost** function (with nested `def`s you will not accidentally select the outer one);
- clicking a **call site** (the name in `utils.load_config(...)`) → selects the **callee**, that is, the other end of that edge — across files this jumps straight to the function in the other file.

Clicking the same function again re-triggers the locate animation (implemented by incrementing `selection.nonce`; otherwise the id does not change and React concludes there is nothing to do).

## Feedback channel

`Feedback` in the top bar opens a read-only panel. **The page exposes exactly two links**: GitHub Issues and an email alias, both of them plain `<a href>` — something happens only when you click. No `fetch`, no beacon, no `<form>`, no `window.open`, no clipboard writes. The reasoning: feedback is the one feature on the whole site that inherently wants to "carry information outward", which makes it the only real counterexample risk to the "your source never goes upstream" promise, so it is built in the shape of "this page physically cannot send anything".

| Channel       | Privacy    | Notes                                                                                                                                              |
| ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Issues | **public** | The primary channel: discussable and trackable, and other people can see the other reports of the same problem                                     |
| Email alias   | private    | A pure forwarding rule; **replies come from a personal mailbox, not from this address**. Currently gated off — until it is enabled the panel does not render this row |

The editable diagnostics block at the bottom of the panel is a **whitelist of 8 fields, counts only**, in a fixed order:

```
build / ua / files / funcs / edges / unresolved / warnings / persisted
```

- No file names, no function names, no source text: arrays contribute only their length and every other type degrades to `0`, so those things **cannot structurally get into** this text (`__tests__/feedback.test.tsx` pins that down with a canary).
- `build` is the **first 8 chars** of the hash in the name of the entry script that is currently executing (the dev bundle from `npm run web` carries no hash, so `unknown` there is expected, not a fault); 8 chars on purpose — see the "a full 32-hex id never goes into a file" rule in §4 of the ops doc.
- `ua` is truncated to 160 chars and the total budget is 600 chars; over budget only the tail of `ua` is sacrificed, never a whole field.
- You may edit or delete this text freely: once you do, **both links carry your edited version**; closing and reopening discards the draft and re-samples the automatic values.

Three gates turn that paragraph into fact instead of relying on reviewer diligence:

1. `npm run audit:egress` (a blocking step in the CI `checks` job) reads `src/feedback/contact.ts`, `src/components/FeedbackDialog.tsx` and `src/platform/web/buildStamp.ts` verbatim: any request primitive (`fetch(` / `<form` / `new Image(` / `navigator.clipboard` …) or any unpublished email literal turns it red — **comments count too**, because it is plain-text matching.
2. A jest canary: feed in a diagnostics source stuffed with conspicuous secrets and assert that none of them show up in any of the three outputs (the text, the Issues href, the mailto).
3. Smoke G1–G6: a full open → close round trip in real headless Chrome asserting that **the request count did not grow by a single one**, and that the panel really floats on top (the hit test at the center of the close button must return the button itself).

The panel's `data-testid` anchors are the contract; renaming one means changing the contract (the smoke script and this document have to change together):
`feedback-dialog` / `feedback-intro` / `feedback-lines` / `feedback-email-label` / `feedback-email` /
`feedback-mail-link` / `feedback-issues-link` / `feedback-diag-label` / `feedback-diag` /
`feedback-hint` / `feedback-close`, and the entry button is `topbar-feedback`.

The entry point is **deliberately not gated by `busy`**: it must stay clickable while parsing and while an old session is being restored from local IndexedDB — the person staring at that restored old version is exactly the one who most needs to report a bug.

The alias is currently gated off by `CONTACT_EMAIL = null` (Email Routing is not enabled). The eight-step enablement runbook (including "you must really send a test mail and confirm delivery — the console showing verified is not evidence") is in §9 of [docs/ops-deployment.md](docs/ops-deployment.md); for why it is shaped as two hrefs see [ADR-0003](docs/adr/0003-feedback-channel-href-only.md).

## Manual acceptance checklist

```bash
npm run web
```

Upload `main.py`, `shapes.py` and `utils.py` from `fixtures/` (select all three at once) and confirm each item:

- [ ] The status at the top shows parsing finished, with roughly **funcs 45 / edges 47 / unresolved 28**
      (`ambiguous 1 / external 14 / dynamic 13 / unknown 0`) — matching the ADR-0002 baseline
- [ ] The call graph appears on the right, nodes colored per file, with a file-color legend at the bottom
- [ ] A cross-file edge is visible: `main.py::boot → utils.py::load_config`
- [ ] A recursive self-loop is visible: `main.py::factorial` points at itself
- [ ] **Graph → code**: click the `utils.py::load_config` node → the left switches to utils.py, scrolls to line 52,
      and the function body carries a highlight band
- [ ] **Code → graph**: click the function name on line 22 of main.py (`def boot():`) → the right centers and highlights `boot`
- [ ] **Call-site jump**: click the name inside `cfg = utils.load_config(...)` on line 24 of main.py →
      what gets selected is `utils.py::load_config` (the callee), not `boot`
- [ ] Zoom & pan: the wheel zooms anchored at the cursor, dragging empty space pans, and `+` / `−` / Fit View all work
- [ ] Scope switching: Neighborhood / This File / All all switch, and under "All" a large-graph hint appears at the top when there are many nodes
- [ ] Removing a single file: click the × on the `utils.py` chip → its nodes and cross-file edges disappear together,
      the file tab on the left is removed in sync, and the current selection is cleared if it pointed into the removed file
- [ ] Error isolation: also upload `fixtures/broken.py` (a deliberate syntax error) → a yellow warning bar names
      broken.py at the top, the other three files still render, and the whole flow does not crash
- [ ] Smooth scrolling on big files: upload a several-thousand-line file and scroll the code area fast without dropping frames
      (the code area is windowed and paints only the visible range ± 24 lines)
- [ ] `Feedback` in the top bar: **clickable even while parsing is in progress** (it is a read-only entry point and deliberately not gated by busy);
      the diagnostics block in the panel is exactly 8 lines of counts (`build` reads `unknown` under dev, because Metro's bundle name carries no entry hash — that is expected);
      edit the diagnostics text → the `href` of the link in the panel changes immediately; close and reopen → the draft is discarded and the automatic values are back
- [ ] Reload the page → files and graph are still there (restored from local IndexedDB); click Clear and reload again → clean, nothing left

The **three bolded core groups** above (graph → code, code → graph, call-site jump) are already automated.
When changing interaction logic, run `node scripts/browser-verify.mjs` first — see the next section.

## Browser automation acceptance (real Chrome + CDP)

jest + jsdom cannot catch problems like "the flashing highlight fades out under real rAF" or "can an SVG node actually be hit by a real mouse" (commit `d0f0832` fixed exactly such a browser-only bug), so there is a second, real-browser script: headless Chrome + the native CDP protocol, with **no dependency on playwright / puppeteer** — anything with Chrome or Chromium installed locally can run it.

```bash
npm run export                  # produce dist/ first
node scripts/browser-verify.mjs # 47 assertions (16 of them promise-surface E/F/G); all green => exit code 0
```

The script starts its own static server for `dist/` and applies the rules in `dist/_headers` verbatim to every response (so the smoke test runs exactly the production CSP). When the port is taken it reuses the existing service, but only after verifying two things: what runs on that port really is this application (the criterion is this project's Metro entry script tag in the HTML — **not `<title>`**, which would misfire as soon as the title changes), and the bytes served match `dist/index.html` exactly. It then launches headless Chrome, feeds in the three `fixtures/` files and clicks SVG nodes and code tokens **with real mouse events**, asserting item by item:

| Group             | Covers                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload            | no red fatal error bar; the graph renders (baseline 45 nodes / 47 edges)                                                                                                                                                                                             |
| A graph → code    | switches file, scrolls to the `def` line fully visible, the highlight band lands on the `def` line; the flash appears → peaks → fades → unmounts; repeated clicks re-trigger it                                                                                        |
| B code → graph    | the target node is centered (deviation < 40px) and its stroke is thickened; the code → graph direction does **not** flash                                                                                                                                            |
| C deep cross-file | jumps from `shapes.py` to `utils.py:95`; scroll amount, highlight band position and flash are all correct                                                                                                                                                            |
| D semantic clicks | clicking a call site selects the callee; clicking a middle line of a body selects the enclosing function                                                                                                                                                             |
| Stability         | no console errors, no uncaught page exceptions                                                                                                                                                                                                                       |
| S artifact identity | the bytes served == the bytes of `dist/index.html` (same sha256); the response headers really carry the CSP from `_headers`; zero absolute URLs in the artifact HTML                                                                                                 |
| E promise surface | every request same-origin / every request a GET / zero request bodies / no 4xx·5xx / every 200 maps to a file that really exists in `dist/` / what runs is that entry JS from `dist` / no user content in any URL / zero `securitypolicyviolation` under the production CSP |
| F icon chain      | `<head>` really contains the four injected icon links; every href decodes as an `<img>` (same origin + CSP `img-src` + MIME all correct)                                                                                                                              |
| G feedback panel  | the top-bar entry opens the panel and the panel **really floats on top** (the hit test at the center of the close button is the button itself); a full open → close round trip adds **not a single request**; the diagnostics block has exactly 8 lines, line i is whitelist field i, and `build` == the first 8 chars of the entry hash under test; the counts are consistent with the numbers really rendered on the page; the `<a>` count == what the gate expects and the Issues anchor's `target`/`rel` are correct |

Optional environment variables:

| Variable           | Default        | Purpose                                                                                                                                          |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CODEMAP_PORT`     | `8099`         | static server port; when taken, the existing service is reused (its bytes are verified to match `dist` and to really be this application)         |
| `CODEMAP_CDP_PORT` | `9333`         | Chrome remote debugging port                                                                                                                     |
| `CHROME_PATH`      | auto-detected  | path to the browser executable (common Windows / macOS / Linux locations are all tried)                                                          |

Screenshots (`codemap-shots/01-initial.png` … `06-deep-crossfile.png`, `07-feedback-panel.png`) and the JSON report (`codemap-verify-report.json`) are written to the system temp directory and are not committed. When it finishes, the script shuts down the server it started.

## Site icon

`public/icon.svg` is the single source of truth: a light paper background + an abstract code graph — four solid rounded nodes in blue/yellow/green/purple (the theme's file colors) joined by three thick round-capped strokes in the theme accent color (keeping the old "nodes + links" skeleton, dropping the grid, the glow, the arrows and the inner lines). `npm run icons` rasterizes it with real Chrome into `favicon.ico` (16/32/48, PNG-in-ICO), `apple-touch-icon.png` (180), `icon-192.png` and `icon-512.png`, **all committed** — so export and the CI checks job can produce a complete `dist/` without a browser. The postexport step of `npm run export` first runs `scripts/inject-html-head.mjs`, which writes four `<link>`s and two `<meta>`s into the `<head>` of the artifact HTML (same-origin relative paths; idempotency sentinel `data-codemap="icon"`, so repeated runs do not stack tags), then runs `polish-dist.mjs` for self-checks — the injected hrefs are covered by the "zero absolute URL" gate too, not an enclave outside it. Icon colors may only come from `src/theme.ts` (`__tests__/icons.test.ts` locks this invariant), so the icon follows the theme when its colors change. Headless Chrome does not fetch `<link rel="icon">`, so the smoke test actively pulls every injected href through an `<img>` (group F), and those requests go through the group E promise surface as well.

## Commands

| Command                           | Purpose                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run web`                     | start the dev server (syncs wasm automatically)                                                                  |
| `npm run export`                  | production export into `dist/`: preexport syncs wasm, postexport injects the icon `<head>` then strips comments and self-checks |
| `npm run copy-wasm`               | only sync + smoke-check wasm; add `-- --no-verify` to skip the check                                             |
| `npm test`                        | the full jest suite                                                                                              |
| `npm run typecheck`               | `tsc --noEmit` (strict)                                                                                          |
| `npm run lint`                    | eslint                                                                                                           |
| `npm run format`                  | prettier write                                                                                                   |
| `npm run verify`                  | typecheck + lint + test — run this before committing                                                             |
| `npm run icons`                   | regenerate the ico / 180 / 192 / 512 rasters from `public/icon.svg`                                              |
| `npm run audit:egress`            | statically scan the three contact-path files: any request primitive or unpublished email literal turns it red (CI blocking) |
| `npm run smoke`                   | real Chrome + CDP automation acceptance (run `npm run export` first)                                             |
| `node scripts/browser-verify.mjs` | same thing, running the script directly                                                                          |

## Directory layout

```
app/                      expo-router entry (single page)
public/
  _headers                production response headers (CSP / cache / HSTS); `expo export` copies the whole directory into dist/
  robots.txt              crawling allowed (change it to Disallow: / to ban the whole site)
  icon.svg                single source of truth for the site icon (vector); after editing you must run npm run icons to regenerate the four below
  favicon.ico             16/32/48 PNG-in-ICO (derived, committed)
  apple-touch-icon.png    iOS home screen 180x180 (derived, committed)
  icon-192.png            generic 192x192 (derived, committed)
  icon-512.png            512x512 (derived, committed)
  wasm/                   the two .wasm files (generated by copy-wasm, not committed)
scripts/
  copy-wasm.mjs           sync wasm + Node smoke check
  build-icons.mjs         rasterize icon.svg with real Chrome -> ico/180/192/512 + self-check
  inject-html-head.mjs    postexport step 1: inject the icon links and meta into dist's <head>
  polish-dist.mjs         post-export processing: strip HTML comments + structural self-check + zero-absolute-URL self-check
  browser-verify.mjs      real-browser (headless Chrome + CDP) acceptance script
  audit-egress.mjs        static scan of the contact path: request primitives / unpublished email literals (CI blocking gate)
.github/workflows/
  ci-and-deploy.yml       gate -> browser smoke -> deploy; the three jobs share the artifact of one single build
fixtures/                 test samples (main/shapes/utils/broken)
src/
  parser/
    treeSitter.ts         wasm lifecycle: init / Language.load / singleton / smoke check
    treeLike.ts           minimal syntax-tree interface (lets the parsing rules be unit-tested without wasm)
    modules.ts            file path -> module name index (package root inference, __init__.py, fuzzy last-segment match)
    imports.ts            import binding table (5 forms + as aliases + wildcards + relative imports)
    symbols.ts            traversal with a scope stack; produces FuncSymbol / ClassSymbol
    locals.ts             local variable frames (used to detect shadowing)
    resolveCalls.ts       call-site resolution (conservative strategy, see ADR-0002)
    builtins.ts           the Python builtin name list
    highlight.ts          token spans colored by leaf node type (cached per line)
    analyze.ts            single-file pipeline orchestration; makePyFile
    types.ts              the public data model
  graph/
    buildGraph.ts         symbols + call sites -> nodes / aggregated edges / stats
    scope.ts              neighborhood / this-file / all clipping
    layout.ts             dagre wrapper (pure function, LR layering, outputs coordinates and edge paths)
  state/store.ts          zustand: files / graph / selection(+nonce) / scope / view / split
  components/
    AppRoot.tsx           assembly + the red error bar for wasm load failure
    TopBar.tsx            upload, file chips, scope switch, feedback entry, stats, warning bar
    FeedbackDialog.tsx    feedback panel: a read-only overlay of native div/a/textarea whose only outward surface is two hrefs
    SplitLayout.tsx       left/right split + draggable divider + narrow-screen stacking
    CodePane/             file tabs + windowed code view + clickable range computation
    GraphPane/            the SVG graph: pan/zoom, node/edge rendering, highlight and dimming
    UploadPanel/          empty state: file picker + drop zone
  feedback/contact.ts     feedback rule layer: 8-field whitelist + count-only reduction + two hrefs (zero framework imports)
  platform/web/           the only DOM touchpoints: file picking/dropping, non-passive wheel and pointer listeners
    buildStamp.ts         takes the first 8 chars of the entry hash from the executing <script src>; returns unknown if unavailable
  theme.ts                dark theme palette, fonts, spacing
docs/adr/                 architecture decision records
__tests__/                jest (pure functions + components + the real-wasm full chain)
```

## Parsing capability and limits

**Edges that do get drawn**: direct calls within a file, cross-file `mod.func()` calls, a bare `f()` after `from m import f`, imports with `as` aliases, relative imports, `self.method()` / `cls.method()`, `Cls.staticmethod()`, instantiation `Cls(...)` → `__init__`, a nested function calling its enclosing function, recursive self-loops.

**Call sites that do not get an edge** are recorded with a reason (`ambiguous` / `external` / `dynamic` / `unknown`) and surfaced in the UI as a node badge plus the stats at the top. The complete rules, the rationale and the rejected alternatives are in [ADR-0002](docs/adr/0002-conservative-call-resolution.md).

Other limits:

- Only `.py` / `.pyi` text files are accepted; each file is capped at 1MB and anything over that is reported as skipped.
- Persistence happens only inside your own browser: the session (including all file contents) is written to local IndexedDB and restored on reload; there is no server-side storage, and clearing site data is a complete deletion.
- Parsing runs in batches on the browser main thread (3 files per batch) — dozens of files feel instant; a repository with thousands of files will stall. A Web Worker is a reserved but not yet enabled optimization slot.
- Static syntax analysis only; none of the uploaded code is ever executed.

## Tests

Three layers, all run by `npm test`:

| Layer                        | Files                                                                                                                                       | Needs wasm?                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Pure-function unit tests** | `modules` / `imports` / `scope` / `layout` / `buildGraph` / `store` / `clickRanges` / `graphPaneMath` / `codeView` / `smoke`                  | No (fake syntax trees through the `treeLike` interface) |
| **Components & interaction**  | `appFlow.test.tsx` / `topBar.test.ts` / `feedback.test.tsx` (canary + whitelist shape + panel rendering)                                     | No (store pre-seeded)                           |
| **Real-wasm full chain**     | `parser.wasm.test.ts` / `imports.wasm.test.ts` / `e2e.wasm.test.tsx`                                                                         | Yes                                             |

When `public/wasm/*.wasm` does not exist, the third layer **skips entirely** instead of failing (the `describeWasm` helper), so even an install done with `--ignore-scripts` can run the first two layers. To run everything: `npm run copy-wasm` first (a normal `npm install` already did it through `postinstall`).

`e2e.wasm.test.tsx` is the one closest to real usage: real wasm parses the fixtures → `store.loadFiles` → render `AppRoot` → real clicks, covering the two core navigation paths from the acceptance checklist above, bad-file degradation, and file-removal sync.

When changing parsing rules, mind the `fixtures/` statistics baseline (funcs 45 / edges 47 / unresolved 28). If the numbers move you must be able to explain why — do not just edit the test.

Beyond `npm test` there is a fourth layer: real-browser acceptance (`node scripts/browser-verify.mjs`, not part of `npm test`). It runs on real Chrome + rAF + native mouse events and covers the flash fade-out and the SVG hit-testing that jsdom cannot; see the "Browser automation acceptance" section.

## Troubleshooting

**`[copy-wasm] 冒烟校验失败` (smoke check failed) / a red error bar at the top of the page**

Most likely the `web-tree-sitter` and language wasm ABIs do not match. Both packages are pinned exactly in `package.json` (`web-tree-sitter` `0.27.0` + `@vscode/tree-sitter-wasm` `0.3.1`); do not upgrade one of them alone. After an upgrade you must re-run `npm run copy-wasm` and confirm the smoke check passes. The red error bar shows the error thrown by `Language.load` verbatim — no silent degradation.

**The page opens but the graph is empty / `LinkError`**

Check whether there really are two `.wasm` files under `public/wasm/`. Both the dev server and `expo export` ship `public/`, so the path is `/wasm/tree-sitter.wasm`.

**The whole page scrolls when zooming with the wheel**

The wheel listener must be **non-passive** (`passive: false`) to be able to `preventDefault`. react-native-web's `onWheel` cannot do that, which is why we subscribe to the native event ourselves in `src/platform/web/domEvents.ts`. Do not regress this back to RN's `onWheel`.

**`npm run export` reports EPERM in some restricted environments**

Expo writes a state file into the user directory (`~/.expo/state.json`). In an environment where that write is sandboxed, point `EXPO_HOME` inside the repository:

```powershell
$env:EXPO_NO_TELEMETRY = "1"; $env:CI = "1"; $env:EXPO_HOME = "$PWD\.expo-home"
npx expo export --platform web --output-dir dist
```

## Release and operations

The full process, the platform pitfalls and the rollback steps are recorded in [docs/ops-deployment.md](docs/ops-deployment.md). The two most common operations:

- **Stop publishing**: set the repository variable `DEPLOY_ENABLED` to `false`. That is the only switch — no code deleted, no job deleted, no credential deleted.
- **Confirm production is the very build you tested**: `npm run export` prints the sha256 of `dist/index.html` at the end; the smoke test's `S1` assertion compares server bytes; `check-deploy.mjs --dist=dist` compares production against the local artifact.
