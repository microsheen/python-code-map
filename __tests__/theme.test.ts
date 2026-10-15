/**
 * 主题的不变量。四组：
 *
 *  1. 结构 —— 6 套主题必须同键同形状。组件里写的是 colors.xxx，只要有一套少了键，
 *     切到那套就是 undefined 色（RNW 会把整条声明丢掉，表现为"这块没有背景色"）。
 *  2. 闭合 —— 界面引用的是 var(--cm-*)。引用一个不存在的变量不会报错，只会静默变成
 *     transparent，所以每个被引用的名字都必须能在 cssVarsFor 的输出里找到；顺带钉住
 *     命名规则本身（camelCase 转 kebab、token 前缀 --cm-tok-、文件色 --cm-file-<i>）。
 *  3. 门禁 —— 官方配色里有几支对中背景不够（GitHub Light 的 comment、Solarized Light 的
 *     中间调），过不了 WCAG 就必须按同色相压暗，而不是放宽阈值。正文 4.5，图形与强调 3.0。
 *     装饰性的 edge / nodeStroke / border* / overlay 不设门禁 —— 它们不承载文字信息。
 *  4. 装载 —— applyPalette / setThemeColorMeta / readThemePref / writeThemePref 是主题
 *     唯一碰 DOM 与 localStorage 的四处，行为必须在 jsdom 里真跑一遍。
 *
 * 对比度用 WCAG 2.1 相对亮度现场算（十几行），不引依赖：helper 只认 6 位 hex，
 * 遇到 rgba() 直接抛 —— 带透明度的色（overlay / *Soft / shadow / underline）本来就不该进门禁。
 */
import {
  colors,
  cssVarsFor,
  DEFAULT_THEME,
  FILE_COLORS,
  THEMES,
  THEME_ORDER,
  tokenColors,
} from '../src/theme';
import type { ThemeId } from '../src/theme';
import {
  THEME_PREF_KEY,
  applyPalette,
  initTheme,
  readThemePref,
  setThemeColorMeta,
  writeThemePref,
} from '../src/platform/web/themeVars';
import { useAppStore } from '../src/state/store';
import { useThemeStore } from '../src/state/themeStore';

/** 主题面板上显示的官方名（README 的界面图与冒烟 H2 用的是同一组字串） */
const LABELS: Record<ThemeId, string> = {
  'github-dark': 'GitHub Dark',
  'github-light': 'GitHub Light',
  dracula: 'Dracula',
  nord: 'Nord',
  'solarized-dark': 'Solarized Dark',
  'solarized-light': 'Solarized Light',
};

const TOKEN_SCOPES = [
  'plain',
  'keyword',
  'string',
  'comment',
  'number',
  'funcName',
  'className',
  'decorator',
  'operator',
  'identifier',
  'constant',
  'self',
  'builtin',
] as const;

const COLOR_KEYS = Object.keys(THEMES[DEFAULT_THEME].colors).sort();
const sorted = (list: readonly string[]) => [...list].sort();
const VARS_TOTAL = COLOR_KEYS.length + TOKEN_SCOPES.length + 10;

// ---------------------------------------------------------------- 对比度 helper

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const digits = m ? m[1] : null;
  if (!digits) throw new Error('对比度门禁只吃 6 位 hex，拿到：' + hex);
  const n = parseInt(digits, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** sRGB 单通道线性化：<= 0.03928 走线性段，否则走 2.4 次幂段（WCAG 2.1 原文） */
function toLinear(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 一次收一批：失败时把所有越界项一起列出来，不用改一个跑一遍 */
function gate(cases: { name: string; fg: string; bg: string; min: number }[]): void {
  const bad = cases
    .map((c) => ({ ...c, ratio: contrast(c.fg, c.bg) }))
    .filter((c) => c.ratio < c.min)
    .map((c) => `${c.name}: ${c.ratio.toFixed(2)} < ${c.min} (${c.fg} on ${c.bg})`);
  expect(bad).toEqual([]);
}

const AA_TEXT = 4.5;
const AA_GRAPHICS = 3.0;

// ---------------------------------------------------------------- 1. 结构

describe('调色板结构', () => {
  it('六套主题、面板顺序与默认项对齐，DEFAULT_THEME 在顺序表里', () => {
    expect(THEME_ORDER).toEqual([
      'github-dark',
      'github-light',
      'dracula',
      'nord',
      'solarized-dark',
      'solarized-light',
    ]);
    expect(sorted(THEME_ORDER)).toEqual(sorted(Object.keys(THEMES)));
    expect(THEME_ORDER).toContain(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe('github-dark');
  });

  it('每套主题 id 自报家门、label 用官方名、scheme 只有 dark/light', () => {
    for (const id of THEME_ORDER) {
      const p = THEMES[id];
      expect(p.id).toBe(id);
      expect(p.label).toBe(LABELS[id]);
      expect(['dark', 'light']).toContain(p.scheme);
    }
  });

  it('六套主题的 colors 键集合逐字一致（31 个），且与组件引用的那份同源', () => {
    expect(COLOR_KEYS.length).toBe(31);
    for (const id of THEME_ORDER)
      expect(sorted(Object.keys(THEMES[id].colors))).toEqual(COLOR_KEYS);
    expect(sorted(Object.keys(colors))).toEqual(COLOR_KEYS);
  });

  it('每套主题覆盖全部 13 个 TokenScope，且与 tokenColors 的键一致', () => {
    for (const id of THEME_ORDER)
      expect(sorted(Object.keys(THEMES[id].tokenColors))).toEqual(sorted(TOKEN_SCOPES));
    expect(sorted(Object.keys(tokenColors))).toEqual(sorted(TOKEN_SCOPES));
  });

  it('fileColors 恰好 10 支 6 位 hex；界面引用的 FILE_COLORS 也是 10 条', () => {
    for (const id of THEME_ORDER) {
      const list = THEMES[id].fileColors;
      expect(list.length).toBe(10);
      for (const c of list) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(FILE_COLORS.length).toBe(10);
  });

  it('新收口的 7 个 token 在场：onAccent / tooltip* / *Soft / shadow / underline', () => {
    for (const key of [
      'onAccent',
      'tooltipBg',
      'tooltipText',
      'dangerSoft',
      'warnSoft',
      'shadow',
      'underline',
    ]) {
      expect(COLOR_KEYS).toContain(key);
      expect(colors[key as keyof typeof colors]).toBe('var(--cm-' + kebab(key) + ')');
    }
    // onAccent 是「压在 accentDim 上的白字」，6 套都是白色：门禁只验 accentDim 够不够暗
    for (const id of THEME_ORDER) expect(THEMES[id].colors.onAccent).toBe('#ffffff');
  });

  it('调色板里只能是字面色（hex 或 rgb/rgba），不许出现 var()：变量套变量会静默失效', () => {
    const literal = /^(#[0-9a-fA-F]{6}|rgba?\()/;
    const bad: string[] = [];
    for (const id of THEME_ORDER) {
      const p = THEMES[id];
      for (const [k, v] of Object.entries(p.colors))
        if (!literal.test(v)) bad.push(`${id}.colors.${k}=${v}`);
      for (const [k, v] of Object.entries(p.tokenColors))
        if (!literal.test(v)) bad.push(`${id}.tokenColors.${k}=${v}`);
      p.fileColors.forEach((v, i) => {
        if (!literal.test(v)) bad.push(`${id}.fileColors[${i}]=${v}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('默认主题逐字沿用加主题之前的界面配色（首屏像素不许变）', () => {
    const d = THEMES[DEFAULT_THEME].colors;
    expect(d.bg).toBe('#0d1117');
    expect(d.panel).toBe('#11161d');
    expect(d.text).toBe('#c9d1d9');
    expect(d.accent).toBe('#58a6ff');
    expect(d.accentDim).toBe('#1f6feb');
    expect(d.paper).toBe('#f6f8fa');
    expect(THEMES[DEFAULT_THEME].tokenColors.keyword).toBe('#ff7b72');
    expect(THEMES[DEFAULT_THEME].fileColors[0]).toBe('#58a6ff');
  });
});

// ---------------------------------------------------------------- 2. 变量闭合

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

describe('CSS 变量闭合', () => {
  const vars = cssVarsFor(THEMES[DEFAULT_THEME]);
  const names = Object.keys(vars);

  it('一套调色板摊平出 54 条：31 UI + 13 token + 10 文件，名字不重复', () => {
    expect(VARS_TOTAL).toBe(54);
    expect(names.length).toBe(VARS_TOTAL);
  });

  it('变量名全部 --cm- 前缀 + 小写 kebab，没有大写、没有空格', () => {
    const off = names.filter((n) => !/^--cm-[a-z0-9]+(-[a-z0-9]+)*$/.test(n));
    expect(off).toEqual([]);
  });

  it('六套主题摊出的变量名逐字相同（否则切主题会留下上一套的孤变量）', () => {
    const base = sorted(names);
    for (const id of THEME_ORDER) expect(sorted(Object.keys(cssVarsFor(THEMES[id])))).toEqual(base);
  });

  it('命名映射规则唯一，与 theme.ts 头注一致', () => {
    const p = THEMES[DEFAULT_THEME];
    expect(vars['--cm-bg']).toBe(p.colors.bg);
    expect(vars['--cm-panel-alt']).toBe(p.colors.panelAlt);
    expect(vars['--cm-on-accent']).toBe(p.colors.onAccent);
    expect(vars['--cm-tok-func-name']).toBe(p.tokenColors.funcName);
    expect(vars['--cm-file-3']).toBe(p.fileColors[3]);
    for (const key of COLOR_KEYS) expect(vars['--cm-' + kebab(key)]).toBeDefined();
  });

  it('界面引用的每个 var(--cm-*) 都能在默认主题里找到，且引用形状正确', () => {
    const referenced: [string, string][] = [
      ...COLOR_KEYS.map(
        (k) => ['colors.' + k, colors[k as keyof typeof colors]] as [string, string]
      ),
      ...TOKEN_SCOPES.map((k) => ['tokenColors.' + k, tokenColors[k]] as [string, string]),
      ...FILE_COLORS.map((v, i) => ['FILE_COLORS[' + i + ']', v] as [string, string]),
    ];
    expect(referenced.length).toBe(VARS_TOTAL);
    const malformed: string[] = [];
    const dangling: string[] = [];
    for (const [where, value] of referenced) {
      const m = /^var\((--cm-[a-z0-9-]+)\)$/.exec(value);
      if (!m) {
        malformed.push(`${where}=${value}`);
        continue;
      }
      const name = m[1];
      if (!name) malformed.push(where + ' 的 var() 里没有变量名：' + value);
      else if (!(name in vars)) dangling.push(where + ' 引用了不存在的 ' + name);
    }
    expect(malformed).toEqual([]);
    expect(dangling).toEqual([]);
  });

  it('没有任何界面色绕开变量直接写字面色（组件里的色只能是 var）', () => {
    const lit = /^(#[0-9a-fA-F]{3,8}|rgba?\()/;
    expect(Object.values(colors).some((v) => lit.test(v))).toBe(false);
    expect(Object.values(tokenColors).some((v) => lit.test(v))).toBe(false);
    expect(FILE_COLORS.some((v) => lit.test(v))).toBe(false);
  });
});

// ---------------------------------------------------------------- 3. 对比度门禁

describe('对比度门禁（WCAG 2.1 相对亮度）', () => {
  it('正文级 ≥ 4.5：text/bg、text/panel、dim/bg、onAccent/accentDim', () => {
    const cases: { name: string; fg: string; bg: string; min: number }[] = [];
    for (const id of THEME_ORDER) {
      const c = THEMES[id].colors;
      for (const [fg, bg] of [
        ['text', 'bg'],
        ['text', 'panel'],
        ['dim', 'bg'],
        ['onAccent', 'accentDim'],
      ] as [keyof typeof c, keyof typeof c][]) {
        cases.push({
          name: `${id} ${String(fg)}/${String(bg)}`,
          fg: c[fg],
          bg: c[bg],
          min: AA_TEXT,
        });
      }
    }
    gate(cases);
  });

  it('13 个语法 token 对 panel ≥ 4.5（代码区大部分面积读的就是这些）', () => {
    const cases: { name: string; fg: string; bg: string; min: number }[] = [];
    for (const id of THEME_ORDER) {
      const panel = THEMES[id].colors.panel;
      for (const scope of TOKEN_SCOPES) {
        cases.push({
          name: `${id} tok.${scope}`,
          fg: THEMES[id].tokenColors[scope],
          bg: panel,
          min: AA_TEXT,
        });
      }
    }
    gate(cases);
  });

  it('图形与强调色对 bg ≥ 3.0：faint / accent / danger / warn / ok / selected / neighbor', () => {
    const cases: { name: string; fg: string; bg: string; min: number }[] = [];
    for (const id of THEME_ORDER) {
      const c = THEMES[id].colors;
      for (const key of [
        'faint',
        'accent',
        'danger',
        'warn',
        'ok',
        'selected',
        'neighbor',
      ] as const) {
        cases.push({ name: `${id} ${key}/bg`, fg: c[key], bg: c.bg, min: AA_GRAPHICS });
      }
    }
    gate(cases);
  });

  it('10 支文件色对 bg 与 panel 都 ≥ 3.0（图例方块与节点描边）', () => {
    const cases: { name: string; fg: string; bg: string; min: number }[] = [];
    for (const id of THEME_ORDER) {
      const c = THEMES[id].colors;
      THEMES[id].fileColors.forEach((fc, i) => {
        cases.push({ name: `${id} file[${i}]/bg`, fg: fc, bg: c.bg, min: AA_GRAPHICS });
        cases.push({ name: `${id} file[${i}]/panel`, fg: fc, bg: c.panel, min: AA_GRAPHICS });
      });
    }
    gate(cases);
  });

  it('默认主题的实测值与既有核算一致（有人悄悄挪色值会在这里红）', () => {
    const p = THEMES[DEFAULT_THEME];
    expect(contrast(p.colors.text, p.colors.bg)).toBeCloseTo(12.26, 2);
    expect(contrast(p.colors.text, p.colors.panel)).toBeCloseTo(11.77, 2);
    expect(contrast(p.colors.dim, p.colors.bg)).toBeCloseTo(6.15, 2);
    expect(contrast(p.colors.onAccent, p.colors.accentDim)).toBeCloseTo(4.63, 2);
    expect(contrast(p.colors.faint, p.colors.bg)).toBeCloseTo(4.12, 2);
    expect(contrast(p.tokenColors.comment, p.colors.panel)).toBeCloseTo(4.87, 2);
    expect(Math.min(...p.fileColors.map((c) => contrast(c, p.colors.bg)))).toBeCloseTo(7.45, 2);
  });
});

// ---------------------------------------------------------------- 4. 运行时装载

describe('运行时装载（jsdom）', () => {
  const metaContent = () =>
    document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
  });

  afterEach(() => {
    document.documentElement.removeAttribute('style');
    localStorage.clear();
  });

  it('偏好键固定：主题只存在 localStorage，不出本机', () => {
    expect(THEME_PREF_KEY).toBe('code-map:theme');
  });

  it('applyPalette 把 54 条变量写进 <html>，color-scheme 跟着 scheme', () => {
    applyPalette('nord');
    const style = document.documentElement.style;
    const expected = cssVarsFor(THEMES.nord);
    const missing = Object.keys(expected).filter((n) => style.getPropertyValue(n) !== expected[n]);
    expect(missing).toEqual([]);
    expect(style.getPropertyValue('--cm-bg')).toBe('#2e3440');
    expect(style.colorScheme).toBe('dark');

    applyPalette('github-light');
    expect(document.documentElement.style.getPropertyValue('--cm-bg')).toBe('#ffffff');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('setThemeColorMeta 只改已有 meta 的 content，不新建第二条', () => {
    setThemeColorMeta('dracula');
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(metaContent()).toBe(THEMES.dracula.colors.bg);
  });

  it('meta 缺席时不凭空长出来（dev 构建里没有注入的那一条）', () => {
    document.querySelector('meta[name="theme-color"]')?.remove();
    setThemeColorMeta('nord');
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(0);
  });

  it('readThemePref：没存过 / 非法值 / 读取抛异常，一律回落默认', () => {
    expect(readThemePref()).toBe(DEFAULT_THEME);
    localStorage.setItem(THEME_PREF_KEY, 'nord');
    expect(readThemePref()).toBe('nord');
    for (const junk of ['', 'NORD', 'bright-purple', 'code-map:theme', '__proto__']) {
      localStorage.setItem(THEME_PREF_KEY, junk);
      expect(readThemePref()).toBe(DEFAULT_THEME);
    }
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(readThemePref()).toBe(DEFAULT_THEME);
    } finally {
      spy.mockRestore();
    }
  });

  it('writeThemePref：写不进去也不冒泡（隐私模式 / 配额满），下次进来回默认', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => writeThemePref('nord')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(localStorage.getItem(THEME_PREF_KEY)).toBeNull();
    writeThemePref('nord');
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe('nord');
  });

  it('initTheme = 读偏好 + 写变量 + 同步 meta，一次跑完（首帧靠它）', () => {
    localStorage.setItem(THEME_PREF_KEY, 'solarized-dark');
    expect(initTheme()).toBe('solarized-dark');
    const bg = THEMES['solarized-dark'].colors.bg;
    expect(document.documentElement.style.getPropertyValue('--cm-bg')).toBe(bg);
    expect(metaContent()).toBe(bg);
  });

  it('没有存过偏好时 initTheme 用默认深色，且不写 localStorage（首访不留痕）', () => {
    expect(initTheme()).toBe(DEFAULT_THEME);
    expect(localStorage.getItem(THEME_PREF_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--cm-bg')).toBe(
      THEMES[DEFAULT_THEME].colors.bg
    );
  });
});

describe('themeStore：切换主题的四件事一次到位', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
  });

  afterEach(() => {
    useThemeStore.getState().setTheme(DEFAULT_THEME);
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.head.innerHTML = '';
  });

  it('初值来自 readThemePref：没存过就是默认深色，不跟随系统', () => {
    expect(useThemeStore.getState().themeId).toBe(DEFAULT_THEME);
  });

  it('setTheme：偏好写进 localStorage、变量写进 <html>、meta 跟着改、状态跟着改', () => {
    useThemeStore.getState().setTheme('nord');
    const bg = THEMES.nord.colors.bg;
    expect(useThemeStore.getState().themeId).toBe('nord');
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe('nord');
    expect(document.documentElement.style.getPropertyValue('--cm-bg')).toBe(bg);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(bg);
  });

  it('与 AppStore 互不干涉：Clear（reset）不会把主题打回默认', async () => {
    useThemeStore.getState().setTheme('dracula');
    await useAppStore.getState().reset();
    expect(useThemeStore.getState().themeId).toBe('dracula');
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe('dracula');
  });
});
