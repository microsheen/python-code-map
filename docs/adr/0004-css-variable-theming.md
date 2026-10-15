# ADR-0004: 界面主题用 CSS 自定义属性落地 —— 六套可切换配色，切换不重渲染

- 状态：已采纳（Accepted）
- 日期：2026-10-15
- 相关：ADR-0001（纯前端静态产物 + CSP；本决策的落地形态被它约束）、ADR-0003（同一套「入口不受 busy 门控」的判断）

## 背景

需求：**界面提供多种风格，用户可以选择。**

动手之前的现状是这样的：

1. 颜色只有一个真源 —— `src/theme.ts` 里的 `colors` / `tokenColors` / `FILE_COLORS` 三张常量表，
   外加 `fonts` / `spacing` / 若干度量常量。9 个组件文件加根布局一共 10 个模块在**模块作用域**
   消费这三张表，其中 7 个文件用 `StyleSheet.create` 把色值烤进 RNW 生成的样式表。
2. 也就是说：色值在模块加载那一刻就被烤进 RNW 生成的样式表了，运行时没有任何一处"还能改"。
3. 全站是纯静态产物（ADR-0001），线上响应头带着 CSP，其中 `script-src 'self'` —— 内联脚本被禁。
4. 代码区是窗口化渲染 + 按行的语法高亮分片（`useMemo`），大文件滚动是性能敏感路径。

要"多套主题"，本质是问：**怎样让已经烤进样式表的颜色在运行时可变，而且代价最小。**

## 决策

### 1. 六套主题 + 顶栏 `Theme` 选择器，偏好存 localStorage

`github-dark`（默认）/ `github-light` / `dracula` / `nord` / `solarized-dark` / `solarized-light`。
顶栏 `Theme` 按钮开一个六行面板，每行是「三个预览色块 + 官方配色名 + 当前项打勾」。

- 偏好写进 localStorage 的 `code-map:theme`，值只有这六个合法取值。**只有这一个键**，
  且和会话持久化一样不出本机（零上行由冒烟 H3 的"请求总数一个都没多"证明）。
- 首次访问固定默认深色，**不跟随系统** `prefers-color-scheme`：跟随系统会让"打开第一眼看到什么"
  取决于浏览器之外的东西，而这条需求要的是"用户可以选择"。系统明暗只通过 `color-scheme`
  影响原生件（见决策 3）。
- 入口故意不受 `busy` 门控，理由和 Feedback 入口逐字相同：解析中、从 IndexedDB 恢复旧会话时，
  正是盯着界面看的时候，那时最该能换配色。

### 2. 落地机制：CSS 自定义属性，导出的形状一个字都不改

`src/theme.ts` 里 `colors` / `tokenColors` / `FILE_COLORS` 的**键名与形状保持不变**，只把值换成
`var(--cm-*)` 形式的引用；真正的色值住在 `THEMES`（六块字面 hex 调色板）里，由纯函数
`cssVarsFor(palette)` 摊平成 54 条「变量名 → 色值」（31 界面色 + 13 语法 token + 10 文件色）。

于是 7 个组件文件里模块级的 `StyleSheet.create` **一行都不用改**：它们引用的还是 `colors.panel`，
只是那个值现在指向 `<html>` 上的一个变量。变量名映射规则唯一（`bg → --cm-bg`、
camelCase 转 kebab、`tokenColors.keyword → --cm-tok-keyword`、`fileColors[3] → --cm-file-3`），
并由 `__tests__/theme.test.ts` 逐条钉住 —— 专门拦"引用了一个不存在的变量"这类**静默失效**。

顺手新增 7 个 token（`onAccent` / `tooltipBg` / `tooltipText` / `dangerSoft` / `warnSoft` /
`shadow` / `underline`），替换掉 6 个组件文件里的 13 处字面色 —— 组件侧这一轮只改了这 13 处，
外加根布局把写死的 `#0d1117` 换成 `colors.bg`。

### 3. 切换主题 = 重写 `<html>` 上的变量，React 完全不参与

`src/platform/web/themeVars.ts` 是全站唯一把调色板写进 DOM 的地方：

- `applyPalette()`：54 条 `setProperty` + `style.colorScheme = 'dark' | 'light'`。
  `color-scheme` 管的是浏览器原生件（滚动条、表单控件、文本光标）的明暗，不写的话亮色主题下
  滚动条还是深色的。
- `setThemeColorMeta()`：只改**已有**那枚 `theme-color` 的 content，不新建第二条。
- `readThemePref()` / `writeThemePref()`：非法值、存储被禁（隐私模式）、配额满 —— 一律静默回落默认。

切换**不触发重渲染**，因此不重新解析文件、语法高亮的 `useMemo` 分片不失效、图不重排。
浏览器重算样式的代价只落在受影响的绘制上，实测改完 `<html>` 后 `getComputedStyle` 立刻是新色值。

### 4. 偏好是独立的小 store，不塞进 AppStore

`src/state/themeStore.ts`：`{ themeId, setTheme }`。

`AppStore.reset()` 的语义是"清掉我正在看的代码"（Clear 按钮、会话恢复失败都走它）。
偏好和被分析的代码不是一回事 —— 混进去的话，一次 Clear 就把用户选了好几天的主题打回默认。
这个 store 存在的唯一理由是**让面板知道该在哪一行画勾**；颜色本身不经过它。

### 5. 首帧靠模块作用域装载，HTML 外壳靠构建时注入的一段内联 style

CSP 的 `script-src 'self'` 禁内联脚本，所以没有 boot script 可用。改为两条腿：

1. `app/_layout.tsx` 在**模块作用域**调 `initTheme()` —— 它是入口 JS 执行的第一批语句，
   早于任何组件渲染，因此不会"先闪一帧默认深色再变成用户选的主题"。
2. `scripts/inject-html-head.mjs`（postexport 第一步）额外注入一段
   `<style data-codemap="shell">:root{--cm-bg:#0d1117}html,body,#root{background-color:var(--cm-bg)}</style>`。
   `style-src` 允许 `unsafe-inline`，所以这段是合法的；它顺手收掉了此前就存在的"HTML 外壳白屏一闪"。

### 6. 图标固定，`theme-color` 跟随

`public/icon.svg` 与四档栅格图标**不随主题变**：站点图标是品牌，跟着浏览器标签页底色变来变去
不是"多套风格"，是"没有一套风格"。地址栏/标签页的 `theme-color` 则跟随当前主题 —— 它的职责正是
让原生外壳贴合页面底色。两者都由 jest 契约钉住（`__tests__/icons.test.ts` 现在从 `THEMES` 反查，
不再正则读 theme.ts 文本）。

### 7. 色值取官方公开色表，但必须过对比度门禁

每套主题取各自配色的官方公开色表，然后过 WCAG 2.1 相对亮度门禁（`__tests__/theme.test.ts` 现场算，
不引依赖）：正文级 ≥ 4.5（`text`/`bg`、`text`/`panel`、`dim`/`bg`、`onAccent`/`accentDim`、
13 个语法 token 对 `panel`），图形与强调 ≥ 3.0（`faint` / `accent` / `danger` / `warn` / `ok` /
`selected` / `neighbor` 对 `bg`，以及 10 支文件色对 `bg` 与 `panel`）。

**过不了门禁就调该套的色值（按同色相压暗），不放宽阈值。** `edge` / `nodeStroke` / `border*` /
`overlay` 属装饰性描边，不设门禁。默认主题逐字沿用加主题之前的界面色，首屏像素不许变。

## 这套机制的两条硬约束

1. **引用值必须以 `var(` 开头。** react-native-web 的 `isWebColor`
   （`node_modules/react-native-web/dist/modules/isWebColor/index.js`）只放行
   `#`hex / `rgb` / 颜色关键字 / 以 `var(` 开头的字符串。写成 `rgba(var(--x), .5)` 会被判成
   非法颜色，**整条声明静默消失** —— 所以带透明度的颜色（`overlay` / `*Soft` / `shadow` /
   `underline`）必须整套定义成变量，不能由不透明色现场拼透明度。
2. **写在 SVG 表现属性上的 `var()` 需要真浏览器背书。** 图节点的
   `fill="var(--cm-node-fill)"` 属于表现属性，规范上允许 `var()`，但这正是 jsdom 测不出来的东西，
   所以冒烟 H4 专门断言它的计算值是 `rgb(...)` 且不含 `var(`。

## 备选方案与为什么不选

| 方案 | 不选的理由 |
| --- | --- |
| React Context + 动态 `StyleSheet.create` | 主题进 Context 就是每次切换重渲染整棵树；样式表要重建，7 个组件文件的模块级样式全得改成 hook 内联；代码高亮的 `useMemo` 依赖里多了 theme，大文件切换主题等于重新分片。为了"换个底色"付这些代价不值 |
| 构建 6 份 CSS 文件，切 `<body class>` | RNW 的 `StyleSheet` 不产出可被外部 class 稳定覆盖的语义（原子类名是哈希），要做就得把色源从 RN 样式表里搬出来 —— 等于再维护一份第二真源 |
| 跟随系统 `prefers-color-scheme` | 需求是"用户可以选择"，不是"我们猜"。系统明暗仍然生效，但只作用在 `color-scheme` 管的浏览器原生件上 |
| 内联 boot script 提前装载主题 | CSP `script-src 'self'` 会拦。为省一帧底色去放宽 CSP，方向反了 |
| 主题塞进 `AppStore` | `reset()` 会连带清掉偏好；一次 Clear 就把用户选了好几天的主题打回默认 |
| 站点图标也做 6 套 | 图标是品牌，不是配色；且 `<link rel="icon">` 换 href 会带来缓存与 CSP `img-src` 的一堆新问题，收益是零 |

## 后果

**得到**：加第 7 套主题的成本降到"写一块字面 hex 调色板 + `THEME_ORDER` 加一个 id"，
变量表由 `cssVarsFor` 派生，组件一行不改；切换是即时的、不重渲染、不发请求；
顺带把 13 处散落字面色收进 7 个新 token，并修掉一处历史白屏闪烁。

**付出**：

- 色源从此分两层（调色板是字面值、界面表是引用），所以"引用了不存在的变量"是一类**新的、
  会静默失效**的错误 —— 由 `theme.test.ts` 的变量闭合性测试兜底，而不是靠人 review。
- 新增颜色必须走变量。组件里直接写字面色会被测试拦下（"没有任何界面色绕开变量直接写字面色"）。
- 对比度门禁会拦住"顺手把一个色挪好看一点"这种改动：挪完过不了就得同色相重调。

**残留限制（明确接受，不靠放宽 CSP 去换）**：存了非默认主题的用户，在入口 JS 执行之前看到的
HTML 外壳仍是**默认底色**（那一段内联 `<style>` 只能烤一份），随后 `initTheme()` 立即把它改成
正确主题。也就是说最坏情况是"首帧外壳一帧深色"，而不是"内容闪一下深色"。

## 这三处是真的实测过（证据）

1. `isWebColor` 放行以 `var(` 开头的字符串：直接读
   `node_modules/react-native-web/dist/modules/isWebColor/index.js` 的判定分支。
2. 真 Chrome（headless + CDP）里：`:root` 上的变量改完 `getComputedStyle` 立即返回新值；
   class 样式与 SVG 表现属性里的 `var()` 都能解析（冒烟 H1/H3/H4）。
3. 切换与刷新：切到 `github-light` 后 `<html>` 变量、`app-root` 计算背景、`theme-color`、
   `color-scheme`、localStorage 五处同时变，且**网络请求总数一个都没多**（H3）；
   刷新后什么都没点就还是亮色、新文档零 CSP 违规（H5）。

## 回归基线

- 6 套主题 × 54 条变量（31 UI + 13 token + 10 文件），变量名六套逐字相同。
- 单测：`theme.test.ts` 30 项 + `themePicker.test.tsx` 10 项；全量 19 suites / 320 tests。
- 冒烟：53 项断言，其中 H1–H6 六项属于本决策。
- 门禁最紧的一处：`solarized-light` 的 `selected`/`bg` = 3.06（阈值 3.0）。
