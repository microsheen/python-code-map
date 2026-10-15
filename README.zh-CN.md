# Python Code Map — Python 函数调用关系图可视化

[English](README.md) | **简体中文** | [日本語](README.ja.md)

## 在线演示

**👉 直接试用：<https://python-code-map.com>** —— 打开网页，把几个 `.py` 文件拖进去，调用关系图就在浏览器里画出来。不用安装、不用注册、不用上传：解析全部发生在你自己的浏览器里。

> 若这个域名在你的网络里打不开，同一份构建也服务在 <https://python-code-map.pages.dev>。

_仓库名、npm 包名、IndexedDB 库名都仍是 `code-map`：前两者只是标识符，后者改了会让已有用户的本地会话直接失联。_

上传一个或多个 `.py` 文件，在浏览器里看到它们的函数调用关系图，左边代码、右边图，两边点击互相定位。

- **纯前端、零上行**：没有后端服务，没有账号，没有数据库，没有第三方脚本或统计。源码只在浏览器里
  解析，不作为任何请求的一部分离开这台机器 —— 这不是口号，是真浏览器门禁里的逐条断言
  （每个请求都是同源、都是 GET、请求体为空、URL 里没有你的文件名或代码片段）。
- **会话只存在你自己的机器上**：文件内容写入浏览器本地 IndexedDB（库 `code-map` /
  store `session` / key `current`），刷新页面可恢复；点 Clear 或清除站点数据即彻底删除，
  服务端永远看不到它。主题选择存在 localStorage 的 `code-map:theme`（全站只有这一个键），同样不出本机。
- **真语法解析**：用 tree-sitter（WASM）解析 Python，不是正则扫行 —— 嵌套 `def`、类方法、
  `async def`、装饰器、相对导入都能正确识别。
- **技术栈**：Expo SDK 57 + React Native Web + react-native-svg + dagre 布局 + zustand。

五个关键设计决策记录在 ADR 里，改代码前建议先读：

- [ADR-0001 纯前端 + tree-sitter WASM，不引后端/Pyodide](docs/adr/0001-expo-rn-web-no-backend.md)
- [ADR-0002 保守的调用解析与 reason 分类](docs/adr/0002-conservative-call-resolution.md)
- [ADR-0003 反馈渠道只长成两枚 href](docs/adr/0003-feedback-channel-href-only.md)
- [ADR-0004 界面主题用 CSS 自定义属性落地（六套可切换）](docs/adr/0004-css-variable-theming.md)
- [ADR-0005 图上的一条线可以点 —— 聚合边的「第几处调用」循环定位](docs/adr/0005-clickable-edges-call-site-cycling.md)

## 快速开始

需要 Node.js 18+（建议 20+）。

```bash
npm install          # 装依赖（需要网络）
npm run web          # 启动 dev server 并打开浏览器（默认 http://localhost:8081）
```

`npm install` 结束时会自动跑 `postinstall`（即 `npm run copy-wasm`）：把两个 `.wasm` 从 node_modules
同步到 `public/wasm/`，并在 Node 里跑一次真机冒烟校验（`Parser.init` + `Language.load` + `parse`）。
看到 `[copy-wasm] 冒烟校验通过` 就说明 wasm ABI 是配套的。这两个 `.wasm` 不入库（见 `.gitignore`），
所以**新克隆的仓库必须先跑一次 `npm install`**；`npm run web` / `npm run export` 还会通过
`preweb` / `preexport` 再同步一次。若安装时带了 `--ignore-scripts`，手动补 `npm run copy-wasm`。

然后：点「选择 .py 文件」上传，或者直接把文件拖进右侧区域。仓库里带了样例可以直接试：
`fixtures/main.py`、`fixtures/shapes.py`、`fixtures/utils.py`、`fixtures/multi.py`（一根线上的三处调用）。

## 界面

```
┌─────────────────────────── 顶部工具栏 ───────────────────────────┐
│ 上传  文件 chips（可单独移除）  范围: 邻域/本文件/全部  Theme  反馈  │
│ 统计: 函数数 / 边数 / 未解析数 + byReason    告警条（坏文件降级）     │
├──────────────────────────┬───────────────────────────────────────┤
│  左：代码                 │  右：调用关系图                        │
│  文件标签页               │  dagre 分层布局（从左到右）             │
│  语法高亮 + 行号          │  节点按所属文件着色，角标=未解析调用数    │
│  函数名/ƒ 标记可点击       │  滚轮缩放、拖拽平移、+ / − / 适应窗口    │
└──────────────────────────┴───────────────────────────────────────┘
```

中间的分隔条可以拖拽（左右比例限制在 25%~75%）；窗口宽度小于 900px 时自动改成上下堆叠。

### 界面主题（6 套可切换）

顶栏 `Theme` 打开一个六行面板：`GitHub Dark`（默认）/ `GitHub Light` / `Dracula` / `Nord` /
`Solarized Dark` / `Solarized Light`。每行是「三个预览色块 + 官方配色名 + 当前项打勾」，
点一行**当场生效**，不用刷新、不用重新上传。

- 机制是 CSS 自定义属性：`src/theme.ts` 导出的 `colors` / `tokenColors` / `FILE_COLORS` 形状不变、
  值变成 `var(--cm-*)`，切主题只是重写 `<html>` 上那 54 条变量。所以**不触发 React 重渲染、
  不重新解析文件、语法高亮的分片不失效**，浏览器也不多发一个请求。
- 选择记在 localStorage `code-map:theme`，刷新与下次打开都保持；首次访问固定默认深色
  （不跟随系统）。点 Clear 不会把主题打回默认 —— 偏好和被分析的代码不是一回事。
- 随主题变的只有配色和 `color-scheme`（浏览器原生件的明暗）。字体、字号、间距、圆角、
  布局尺寸、站点图标都不变。
- 每套色值取自该配色的官方公开色表，再过 WCAG 对比度门禁（正文 ≥ 4.5、图形与强调 ≥ 3.0，
  门禁在 `__tests__/theme.test.ts`）；过不了就按同色相调该套的色值，不放宽阈值。
- 入口故意不受 `busy` 门控，理由和 `Feedback` 一样：解析中、从本机恢复旧会话时最该能换配色。
- 面板的 `data-testid` 锚点即契约：`topbar-theme` / `theme-panel` / `theme-option-<id>`。
- 为什么走这条路（含被 CSP 挡掉的内联 boot script、以及因此残留的那一帧底色）见
  [ADR-0004](docs/adr/0004-css-variable-theming.md)。

## 双向定位（核心功能）

**图 → 代码**：点击图中任意函数节点，左侧会

1. 自动切到该函数所在的文件标签页；
2. 滚动到它的 `def` 行；
3. 用一条高亮带覆盖整个函数体（`startLine..endLine`），并闪烁一次；
4. 右侧图裁剪到该函数的邻域（它自己 + 直接 callers/callees）。

**代码 → 图**：点击代码里的函数，右侧会

1. 重算范围子图与布局；
2. 把该节点移到视口正中（保持当前缩放比例）；
3. 高亮该节点及其直接调用边，其余节点/边降低透明度。

代码里的点击是**语义感知**的，不是简单的"点哪行选哪行"：

- 点函数名（`def boot` 里的 `boot`）或行号旁的 `ƒ` 标记 → 选中该函数；
- 点函数体内任意一行 → 选中**最内层**的那个函数（嵌套 `def` 场景下不会选错到外层）；
- 点一个**调用点**（`utils.load_config(...)` 里的名字）→ 选中的是**被调方**，
  也就是这条边的另一端 —— 跨文件时会直接跳到另一个文件的函数。

重复点击同一个函数也会重新触发定位动画（内部靠 `selection.nonce` 自增实现，
否则 id 没变、React 认为什么都不用做）。

### 点一条线：一根聚合边背后的 N 处调用

节点是一个函数，边却是**聚合**：A 调用 B 的每一次都合并成一条折线，线宽随次数变粗（ADR-0002）。
被合并掉的每一次调用仍然留在这条边上，所以**这根线本身也可以点**：

- **点线** → 代码区切到 caller 所在的文件、滚到**第 1 处**调用、只闪那一行，并把这条边的**全部**
  调用点标出来：不是当前的那几处画一条下划线，当前这一处铺底色 + 一枚序号角标。角标画在**行号左边**
  （sticky 行号槽里，与 `ƒ` 共用那个槽位、调用点优先），代码横向滚动时它和行号一起留在视口左边。
- **再点同一条线** → 第 2 处、第 3 处，到最后一处后再点**绕回**第 1 处。`Shift`+点击沿同一圈往回走。
  点一条还没被标记的边时永远从第 1 处开始 —— 没有「当前」，也就无所谓「后退一步」。
- **`‹ 2/3 ›`** 步进器在代码区右下角，不用去追一根细线；`✕` 清除。
- **只有一处调用的那根线什么都不铺**：没有步进器、没有下划线、没有角标 —— 只有一个答案时没有可翻的
  页。定位照样发生，只是交给滚动、1.2 秒的闪烁、底栏那句 `file:line` 和图上变粗的那根线
  （见 [ADR-0005 §8](docs/adr/0005-clickable-edges-call-site-cycling.md)）。
- **图底部那一行**说明现在落在哪：`caller → callee · 2/3 · multi.py:7`（只有 1 处调用时不显示 `· 2/3`）。
- **悬停**：光标变成 pointer，浮层告诉你点下去会落到哪（`caller → callee · 3 call sites · first at line 6`）。
  边数超过 1500 时悬停命中自动关掉以保住大图的流畅，点击不受影响。
- **反向也点亮同一根线**：在代码里点一个调用点，会带着 `origin: 'code'` 选中这条边 —— 代码本来就在
  眼前，所以那条路径不滚动、不闪烁。

所有「第几处」的序号只有一个来源：`src/graph/edges.ts` 里的 `compareCallSites`（先按行号，同一行按列，
最后拿原文兜底），所以角标、步进器、底部说明和测试里说的「第 2/3 处」是同一件事。还有一条解析层的不变量
让这件事可做：**一条边的所有调用点必然在同一个文件里** —— caller 只可能定义在一个文件，它的调用点自然都
在那个文件，代码区因此不需要跨文件分组。

点线刻意**不碰别的东西**：选中态、范围、导航历史、缩放平移一个都不动，也不发一个请求。「我在看哪条边」
和「我在看哪个函数」是两根轴，逐处看三次调用不该把你裁好的邻域炸掉。任何真实的选中变化（点节点、点代码、
切范围、前进后退、移除文件、重传、Clear）都会清掉这些标记，点图的空白处同样会。

线的命中用的是和画它同一批密采样点，容差 7 个**屏幕像素**（`EDGE_HIT_TOL`，除以当前缩放，所以无论放大
缩小手感一致），并且节点永远优先于压在线上的光标。`data-testid` 就是契约：图侧 `graph-edge-<src>-><tgt>` /
`graph-edge-tooltip` / `graph-edge-info`，代码侧 `callsite-stepper` / `callsite-prev` / `callsite-count` /
`callsite-next` / `callsite-clear` / `callsite-mark-<i>` / `callsite-mark-active`。只有一处调用的那根线，
代码侧这些 id 一个都不存在；`callsite-mark-active` 现在渲染在这一行的 sticky 行号槽里，不再是覆盖层 ——
断言若只写「存在但为空」就会放过这个回归。为什么是循环，而不是拆成平行边、弹一个列表、
只跳第一处、或在线上钉 ①②③：见 [ADR-0005](docs/adr/0005-clickable-edges-call-site-cycling.md)。

## 反馈渠道

顶栏的 `Feedback` 打开一个只读面板。**页面对外只有两枚链接**：GitHub Issues 与邮件别名，
两枚都是普通 `<a href>` —— 只有你点下去才会发生事。没有 `fetch`、没有 beacon、没有 `<form>`、
没有 `window.open`、不写剪贴板。理由是：反馈是全站唯一一个天生要「往外搬信息」的功能，
也就是「源码不上行」那条承诺唯一真正的反例风险，所以它被做成「页面上根本发不出东西」的形状。

| 渠道 | 隐私 | 说明 |
| --- | --- | --- |
| GitHub Issues | **公开** | 主渠道：可讨论、可跟进，别人也能看到同一个问题的其它报告 |
| 邮件别名 | 私密 | 纯转发规则，**回信来自一个个人邮箱、不是这个地址**；当前门控关闭，未开通前面板不渲染这一条 |

面板底部那块可编辑的诊断文本是**白名单 8 个字段、只有计数**，顺序固定：

```
build / ua / files / funcs / edges / unresolved / warnings / persisted
```

- 没有文件名、没有函数名、没有代码原文：收数组只吐长度，其它类型一律退化成 `0`，
  所以那些东西**在结构上进不了**这段文本（`__tests__/feedback.test.tsx` 用一枚金丝雀钉住这件事）。
- `build` 是正在执行的那枚入口脚本名里的哈希**前 8 位**（`npm run web` 的 dev bundle 不带哈希，
  此时显示 `unknown` 是预期，不是故障）；刻意只取 8 位，见 ops 文档第 4 节那条「完整 32 位
  十六进制不进文件」的戒。
- `ua` 截到 160 字符、总长预算 600 字符，超预算只牺牲 `ua` 的尾巴，绝不整行丢弃字段。
- 你可以随手改或删这段文本：一旦动过，**两枚链接都带上你改后的内容**；关掉再打开会丢弃草稿、
  重新采样自动值。

三道闸门把上面那句话变成事实，而不是靠 review 自觉：

1. `npm run audit:egress`（CI `checks` 里的 blocking 步骤）逐字读 `src/feedback/contact.ts`、
   `src/components/FeedbackDialog.tsx`、`src/platform/web/buildStamp.ts`：出现任何请求原语
   （`fetch(` / `<form` / `new Image(` / `navigator.clipboard` …）或任何未公开的邮箱字面量就红 ——
   **注释里也算**，因为它是纯文本匹配。
2. jest 金丝雀：把塞满显眼秘密的诊断来源喂进去，断言它们在文本、Issues href、mailto 三种输出里
   一个都不出现。
3. 冒烟 G1–G6：真 headless Chrome 里开→关整个来回，断言**请求数一个都没多**，并且面板真的
   浮在最上面（关闭按钮中心的命中测试必须是它自己）。

面板的 `data-testid` 锚点即契约，改名字等于改契约（冒烟脚本与这份文档要一起改）：
`feedback-dialog` / `feedback-intro` / `feedback-lines` / `feedback-email-label` / `feedback-email` /
`feedback-mail-link` / `feedback-issues-link` / `feedback-diag-label` / `feedback-diag` /
`feedback-hint` / `feedback-close`，入口按钮是 `topbar-feedback`。

入口**故意不受 `busy` 门控**：解析中、以及从本机 IndexedDB 恢复出旧会话时都必须能点 ——
盯着那份恢复出来的旧版本看的人，正是最需要报 bug 的人。

别名当前由 `CONTACT_EMAIL = null` 门控关闭（Email Routing 未开通）。启用八步 runbook（含
「必须真发一封测试信确认到达，控制台显示 verified 不算证据」）见
[docs/ops-deployment.md](docs/ops-deployment.md) 第 9 节；为什么长成两枚 href 见
[ADR-0003](docs/adr/0003-feedback-channel-href-only.md)。

## 手动验收清单

```bash
npm run web
```

上传 `fixtures/` 里的 `main.py`、`shapes.py`、`utils.py`、`multi.py`（四个一起选），逐项确认：

- [ ] 顶部状态显示解析完成，统计约为 **函数 47 / 边 50 / 未解析 26** —— 也就是三个文件的 ADR-0002 基线
      （**45 / 49 / 26**，`ambiguous 1 / external 14 / dynamic 11 / unknown 0`）再加上 `multi.py` 带来的
      2 个函数与 1 条聚合边；不选 `multi.py` 就回到基线
- [ ] 右侧出现调用图，节点按文件着色，底部有文件色图例
- [ ] 能看到跨文件的边：`main.py::boot → utils.py::load_config`
- [ ] 能看到递归自环：`main.py::factorial` 指向自己
- [ ] **图 → 代码**：点 `utils.py::load_config` 节点 → 左侧切到 utils.py、滚到第 52 行、
      函数体有高亮带
- [ ] **代码 → 图**：点 main.py 第 22 行 `def boot():` 的函数名 → 右侧把 `boot` 居中并高亮
- [ ] **调用点跳转**：点 main.py 第 24 行 `cfg = utils.load_config(...)` 里的名字 →
      选中的是 `utils.py::load_config`（被调方），不是 `boot`
- [ ] **边 → 调用点**（要把 `multi.py` 和上面三个一起选）：点图里 `caller → callee` 那条线 → 左侧切到
      multi.py、滚到第 6 行、三处调用都画上标记；再点同一条线 → 第 7 行，再点 → 第 8 行，再点 → 绕回第 6
      行。`Shift`+点击往回走；代码区右下角的 `‹ 2/3 ›` 不追线也能走，`✕` 或点图的空白处清除；图底部那行
      写着 `caller → callee · 2/3 · multi.py:7`，悬停时浮层预告 `3 call sites · first at line 6`
- [ ] **只有一处调用的线**：点一根只有一次调用的线（比如 `load_config → parse_lines`，唯一的调用点在
      `utils.py:54`）→ 左侧切到 utils.py、滚过去、闪那一行，图底部写着
      `load_config → parse_lines · utils.py:54`，而代码区**没有步进器、没有下划线、也没有角标**；
      点图上任意节点就把痕迹清掉
- [ ] 缩放平移：滚轮以光标为锚点缩放、拖拽空白处平移、`+` / `−` / 适应窗口按钮都正常
- [ ] 范围切换：邻域 / 本文件 / 全部 三档都能切，「全部」下节点多时顶部出现大图提示
- [ ] 移除单个文件：点 `utils.py` chip 上的 × → 该文件相关的节点与跨文件边一起消失，
      左侧文件标签页同步移除，当前选中若指向被删文件则被清空
- [ ] 错误隔离：再上传 `fixtures/broken.py`（故意语法错误）→ 顶部出现黄色告警条并点名
      broken.py，其余四个文件照常出图，整个流程不崩
- [ ] 大文件滚动流畅：上传一个几千行的文件，快速滚动代码区不掉帧
      （代码区是窗口化渲染，只画可视区间 ± 24 行）
- [ ] 顶栏 `Feedback`：**解析进行中也能点**（它是只读入口，故意不受 busy 门控）；面板里的诊断块
      只有 8 行计数（`build` 在 dev 下是 `unknown`，因为 Metro 的 bundle 名不带入口哈希 —— 这是预期）；
      改一下诊断文本 → 面板里那枚链接的 `href` 立刻跟着变；关掉再打开 → 草稿丢弃、回到自动值
- [ ] 主题：点顶栏 `Theme` → 六行面板出现且浮在最上面；点 `Nord` → **不刷新就整个界面跟着变**
      （代码区、图、语法高亮、滚动条、地址栏底色一起换），面板自动关；再开面板勾在 Nord 那行
- [ ] 主题持久化：刷新页面 → 还是 Nord，且首帧就是 Nord（不闪回默认深色）；切回 GitHub Dark →
      全部复原；点 Clear 后主题**不**跟着回到默认

上面**加粗的四组核心项**（图 → 代码、代码 → 图、调用点跳转、边 → 调用点）已经自动化了，
改交互逻辑时优先跑 `node scripts/browser-verify.mjs`，见下一节。

## 浏览器自动化验收（真 Chrome + CDP）

jest + jsdom 测不出「闪烁高亮在真实 rAF 下淡出」「SVG 节点能不能被真实鼠标点中」这类问题
（提交 `d0f0832` 修的正是这种只在真浏览器里复现的 bug），所以另配了一个真浏览器脚本：
headless Chrome + 原生 CDP 协议，**不依赖 playwright / puppeteer**，本机装了 Chrome 或
Chromium 就能跑。

```bash
npm run export                  # 先产出 dist/
node scripts/browser-verify.mjs # 74 项断言（含 16 项承诺面 E/F/G、21 项边 → 调用点），全绿退出码 0
```

脚本自己起一个静态服务器托管 `dist/`，并把 `dist/_headers` 里的规则原样套到每个响应上
（冒烟跑的正是线上那一套 CSP）。端口被占用时会复用已有服务，但先校验两件事：那个端口上跑的
确实是本应用（判据是 HTML 里带着本项目 Metro 的入口脚本标签，**不用 `<title>`**，标题一改
就会误判），且服务端字节与 `dist/index.html` 完全一致。然后拉起 headless Chrome，把
`fixtures/` 四个文件喂进去，**用真实鼠标事件**点击 SVG 节点、SVG 边与代码 token，逐项断言：

| 组           | 覆盖                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| 上传         | 没有红色致命错误条；图渲染出来（四个样例的基线 47 节点 / 50 边）                                                  |
| A 图 → 代码  | 切文件、滚到 `def` 行且完整可见、高亮带落在 `def` 行；闪烁出现 → 峰值 → 淡出 → 卸载；重复点击能重新触发 |
| B 代码 → 图  | 目标节点居中（偏差 < 40px）、描边加粗；代码 → 图方向**不**闪烁                                          |
| C 深层跨文件 | 从 `shapes.py` 跳到 `utils.py:95`，滚动量、高亮带位置、闪烁都对                                         |
| D 语义点击   | 点调用点选中的是被调方；点函数体中间行选中的是所在函数                                                  |
| I 边 → 调用点 | 用真实鼠标点击 multi.py 里那条聚合折线 `caller → callee`：切文件、1/3 → 2/3 → 3/3 → 1/3 循环、`Shift` 反向逐步、三处调用点全打点且 x 严格递增、序号角标实测落在**行号左边**（量的是距所在行左缘 5..19px）、`‹ ›` 步进器与 `✕`、只有一处调用的那根线**既没有步进器也没有标记**却照样滚到并闪在第 54 行、悬停浮层 + pointer 光标，整组**请求数一个都没多** |
| 稳定性       | 控制台无 error、页面无未捕获异常                                                                        |
| S 产物一致性 | 服务端返回的字节 == `dist/index.html` 的字节（sha256 相同）；响应头里真的带着 `_headers` 的 CSP；产物 HTML 里零绝对 URL |
| E 承诺面     | 全部请求同源 / 全部 GET / 零请求体 / 无 4xx·5xx / 每个 200 都对应 `dist/` 里真实存在的文件 / 跑的就是 `dist` 那个入口 JS / URL 里没有用户内容 / 生产 CSP 下零 `securitypolicyviolation` |
| F 图标链路   | `<head>` 里真有注入的四个图标 link；每个 href 都能当 `<img>` 解码（同源 + CSP `img-src` + MIME 全对） |
| G 反馈面板   | 顶栏入口开得出面板、且面板**真浮在最上面**（关闭按钮中心的命中测试就是它自己）；开→关整个来回**请求数一个都没多**；诊断块恰好 8 行、第 i 行是第 i 个白名单字段、`build` == 被测入口哈希前 8 位；计数与页面上真实渲染的数字自洽；`<a>` 数 == 门控期望且 Issues 锚点 `target`/`rel` 正确 |
| H 主题       | 首访 = 默认主题（54 条变量逐条 == 源码调色板、`theme-color` 与壳层 `<style>` 同字面 hex、localStorage 无偏好键）；`Theme` 面板开得出且**真浮在最上面**、六行按 `THEME_ORDER`、预览块是各主题的字面 rgb（零 `var(`）；切到 GitHub Light 后 `<html>` 变量 / `app-root` 计算背景 / `theme-color` / `color-scheme` / localStorage 五处同时变，**请求总数一个都没多**；写在 SVG 表现属性上的 `fill="var(--cm-node-fill)"` 真浏览器算得出 rgb；刷新后不点任何东西仍是亮色且新文档零 CSP 违规；切回默认全部复原 |

可选环境变量：

| 变量               | 默认     | 作用                                                               |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `CODEMAP_PORT`     | `8099`   | 静态服务端口；被占用时复用已有服务（会校验字节与 `dist` 一致且确为本应用） |
| `CODEMAP_CDP_PORT` | `9333`   | Chrome 远程调试端口                                                |
| `CHROME_PATH`      | 自动探测 | 浏览器可执行文件路径（Windows / macOS / Linux 常见位置都会试一遍） |

截图（`codemap-shots/01-initial.png` … `06-deep-crossfile.png`、`11-edge-callsite.png`（I 组期间落的图）、`07-feedback-panel.png`、
`08-theme-panel.png`、`09-theme-light.png`、`10-theme-default-restored.png`）与 JSON 报告
（`codemap-verify-report.json`）都写在系统临时目录，不入库。跑完脚本会关掉自己起的服务器。

## 站点图标

`public/icon.svg` 是唯一真源：浅纸面 + 抽象代码图 —— 四色实心圆角节点（蓝/黄/绿/紫，即主题的文件色），
由三条主题强调色的圆头粗笔画相连（保留旧版「节点 + 连线」骨架，去掉网格、光晕、箭头与内线）；
`npm run icons` 用真 Chrome 把它栅格化成 `favicon.ico`（16/32/48，PNG-in-ICO）、
`apple-touch-icon.png`（180）、`icon-192.png`、`icon-512.png`，**全部入库** —— 导出与 CI 的
checks job 不需要浏览器也能产出完整 `dist/`。`npm run export` 的 postexport 先跑
`scripts/inject-html-head.mjs`，把四个 `<link>` 与两个 `<meta>` 写进产物 HTML 的 `<head>`
（同源相对路径；幂等哨兵 `data-codemap="icon"`，重复运行不叠标签），再跑 `polish-dist.mjs`
自检 —— 注入进来的 href 也在「零绝对 URL」门禁的覆盖范围内，不是门禁之外的飞地。
图标配色只允许来自 `src/theme.ts` 的**默认主题**（`__tests__/icons.test.ts` 锁死这条不变量）。
界面有 6 套主题，图标和品牌色没有：切主题时图标**不动**（品牌固定），只有地址栏的
`theme-color` 跟随当前主题；headless Chrome 不抓 `<link rel="icon">`，所以冒烟里用 `<img>`
主动把每个注入 href 拉一遍（F 组），请求同样进 E 组承诺面。

## 命令

| 命令                              | 作用                                                    |
| --------------------------------- | ------------------------------------------------------- |
| `npm run web`                     | 启动 dev server（自动同步 wasm）                        |
| `npm run export`                  | 生产导出到 `dist/`：preexport 同步 wasm，postexport 注入图标 `<head>` 再剥注释自检 |
| `npm run copy-wasm`               | 只同步 + 冒烟校验 wasm；加 `-- --no-verify` 跳过校验    |
| `npm test`                        | jest 全量测试                                           |
| `npm run typecheck`               | `tsc --noEmit`（strict）                                |
| `npm run lint`                    | eslint                                                  |
| `npm run format`                  | prettier 写入                                           |
| `npm run verify`                  | typecheck + lint + test，提交前跑这个                   |
| `npm run icons`                   | 从 `public/icon.svg` 重生成 ico / 180 / 192 / 512 栅格档  |
| `npm run audit:egress`            | 静态扫描联系路径那三个文件：出现请求原语或未公开邮箱字面量就红（CI blocking） |
| `npm run smoke`                   | 真 Chrome + CDP 自动化验收（先 `npm run export`）        |
| `node scripts/browser-verify.mjs` | 同上，直接跑脚本                                        |

## 目录结构

```
app/                      expo-router 入口（单页）
public/
  _headers                线上响应头（CSP / 缓存 / HSTS），`expo export` 会整目录拷进 dist/
  robots.txt              允许被检索（改成 Disallow: / 即全站禁抓）
  icon.svg                站点图标唯一真源（矢量）；改完必须 npm run icons 重生成下面四个
  favicon.ico             16/32/48 三档 PNG-in-ICO（派生物，入库）
  apple-touch-icon.png    iOS 主屏 180x180（派生物，入库）
  icon-192.png            通用 192x192（派生物，入库）
  icon-512.png            512x512（派生物，入库）
  wasm/                   两个 .wasm（由 copy-wasm 生成，不入库）
scripts/
  copy-wasm.mjs           同步 wasm + Node 冒烟校验
  build-icons.mjs         真 Chrome 栅格化 icon.svg -> ico/180/192/512 + 自检
  inject-html-head.mjs    postexport 第一步：把图标 link、meta 与壳层底色 <style> 注入 dist 的 <head>
  polish-dist.mjs         导出后处理：剥 HTML 注释 + 结构自检 + 零绝对 URL 自检
  browser-verify.mjs      真浏览器（headless Chrome + CDP）验收脚本
  audit-egress.mjs        静态扫描联系路径：请求原语 / 未公开邮箱字面量（CI blocking 闸门）
.github/workflows/
  ci-and-deploy.yml       门禁 -> 浏览器冒烟 -> 部署，三个 job 共用同一次构建的产物
fixtures/                 测试样例（main/shapes/utils/multi/broken）
src/
  parser/
    treeSitter.ts         wasm 生命周期：init / Language.load / 单例 / 冒烟校验
    treeLike.ts           语法树的最小接口（让解析规则可以脱离 wasm 单测）
    modules.ts            文件路径 -> 模块名索引（包根推断、__init__.py、尾段模糊匹配）
    imports.ts            import 绑定表（5 种形式 + as 别名 + 通配 + 相对导入）
    symbols.ts            带作用域栈遍历，产出 FuncSymbol / ClassSymbol
    locals.ts             局部变量帧（用于识别遮蔽）
    resolveCalls.ts       调用点解析（保守策略，见 ADR-0002）
    builtins.ts           Python 内置名单
    highlight.ts          按叶子节点类型着色的 token span（按行缓存）
    analyze.ts            单文件管线编排；makePyFile
    types.ts              对外数据模型
  graph/
    buildGraph.ts         符号 + 调用点 -> 节点/聚合边/统计
    scope.ts              邻域 / 本文件 / 全部 三种裁剪
    layout.ts             dagre 包装（纯函数，LR 分层，输出坐标与边路径）
    edges.ts              边的身份（key）+ 一条边背后调用点的唯一排序口径
  state/store.ts          zustand：files / graph / selection(+nonce) / scope / view / split
  state/themeStore.ts     zustand：当前主题 id + setTheme（独立于 store，Clear 不会清掉偏好）
  components/
    AppRoot.tsx           装配 + wasm 加载失败的红色错误条
    TopBar.tsx            上传、文件 chips、范围切换、主题选择器、反馈入口、统计、告警条
    FeedbackDialog.tsx    反馈面板：原生 div/a/textarea 的只读遮罩，对外只有两枚 href
    SplitLayout.tsx       左右分栏 + 可拖拽分隔条 + 窄屏堆叠
    CodePane/             文件标签页 + 窗口化代码视图 + 可点击范围计算 + 调用点标记与步进器
    GraphPane/            SVG 图：平移缩放、节点/边渲染、高亮、降透明、可点击的边
    UploadPanel/          空态：选择文件 + 拖放区
  feedback/contact.ts     反馈规则层：白名单 8 字段 + 计数收口 + 两枚 href（零框架 import）
  platform/web/           唯一的 DOM 触点：文件选择/拖放、非被动 wheel 与指针监听
    buildStamp.ts         从正在执行的 <script src> 取入口哈希前 8 位，取不到返回 unknown
    themeVars.ts          主题运行时装载：54 条 --cm-* 写进 <html>、color-scheme、theme-color、偏好读写
  theme.ts                6 套调色板（字面 hex）+ cssVarsFor；界面色以 var(--cm-*) 引用；字体、间距
docs/adr/                 架构决策记录
__tests__/                jest（纯函数 + 组件 + 真 wasm 全链路）
```

## 解析能力与限制

**能连的边**：同文件直接调用、`mod.func()` 跨文件调用、`from m import f` 后裸调 `f()`、
带 `as` 别名的 import、相对 import、`self.method()` / `cls.method()`、`Cls.staticmethod()`、
实例化 `Cls(...)` → `__init__`、嵌套函数调用外层函数、递归自环。

**不连的调用点**会带一个 reason 被记录下来（`ambiguous` / `external` / `dynamic` / `unknown`），
并在 UI 上以节点角标 + 顶部统计的形式暴露。完整规则、理由和被否掉的备选方案见
[ADR-0002](docs/adr/0002-conservative-call-resolution.md)。

其他限制：

- 只接受 `.py` / `.pyi` 文本文件；单文件按 1MB 上限处理，超出会提示跳过。
- 持久化只发生在你自己的浏览器里：会话（含全部文件内容）写入本机 IndexedDB，刷新可恢复；
  没有服务端存储，清除站点数据等于彻底删除。
- 解析在浏览器主线程分批执行（每批 3 个文件），几十个文件无感；上千文件的大仓会卡，
  Web Worker 是已预留但未启用的优化位。
- 只做静态语法分析，不执行任何被上传的代码。

## 测试

三层，`npm test` 全跑：

| 层                 | 文件                                                                                                                         | 依赖 wasm？                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **纯函数单测**     | `modules` / `imports` / `scope` / `layout` / `buildGraph` / `edges` / `store` / `clickRanges` / `graphPaneMath` / `codeView` / `smoke` / `theme`（调色板结构 + 变量闭合 + WCAG 门禁） | 否（用 `treeLike` 接口喂假语法树；`edges` 也吃手搓的图） |
| **组件与交互**     | `appFlow.test.tsx` / `topBar.test.ts` / `feedback.test.tsx`（金丝雀 + 白名单形状 + 面板渲染） / `themePicker.test.tsx`（主题面板与切换） | 否（预置 store）                   |
| **真 wasm 全链路** | `parser.wasm.test.ts` / `imports.wasm.test.ts` / `e2e.wasm.test.tsx`                                                         | 是                                 |

`public/wasm/*.wasm` 不存在时，第三层会**整体跳过**而不是失败（`describeWasm` 助手），
这样即便安装时带了 `--ignore-scripts` 也能先把前两层跑完。想跑全量：先 `npm run copy-wasm`
（正常 `npm install` 已由 `postinstall` 自动完成）。

`e2e.wasm.test.tsx` 是最接近真实使用的一份：真 wasm 解析 fixtures → `store.loadFiles` →
渲染 `AppRoot` → 真点击，覆盖上面验收清单里的两条核心定位路径、坏文件降级、移除文件同步。

改解析规则时注意 `__tests__/parser.wasm.test.ts` 读的那三个文件的统计基线（函数 45 / 边 49 / 未解析 26），
数字变了要能解释原因，别顺手改测试。`fixtures/multi.py`（为可点的边新增）和 `fixtures/broken.py`
故意不进这份基线；`multi.py` 也正是真浏览器冒烟里四个样例渲染出 47 节点 / 50 边的原因。

`npm test` 之外还有第四层：真浏览器验收（`node scripts/browser-verify.mjs`，不在 `npm test` 里）。
它跑在真实 Chrome + rAF + 原生鼠标事件上，覆盖 jsdom 测不到的闪烁淡出与 SVG 命中，
见「浏览器自动化验收」一节。

## 故障排查

**`[copy-wasm] 冒烟校验失败` / 页面顶部出现红色错误条**

多半是 `web-tree-sitter` 与语言 wasm 的 ABI 不配套。这两个包在 `package.json` 里是精确锁版本的
（`web-tree-sitter` `0.27.0` + `@vscode/tree-sitter-wasm` `0.3.1`），不要单独升级其中一个。
升级后必须重跑 `npm run copy-wasm` 并确认冒烟通过。红色错误条会原样显示 `Language.load`
抛出的错误，不静默降级。

**页面能开但图是空的 / 报 `LinkError`**

检查 `public/wasm/` 下是否真的有两个 `.wasm`。dev server 与 `expo export` 都会带上 `public/`，
所以路径是 `/wasm/tree-sitter.wasm`。

**滚轮缩放时整个页面跟着滚**

wheel 监听必须是**非被动**的（`passive: false`）才能 `preventDefault`。react-native-web 的
`onWheel` 做不到这点，所以我们在 `src/platform/web/domEvents.ts` 里自己订阅原生事件。
改这块时别退回到 RN 的 `onWheel`。

**`npm run export` 在某些受限环境里报 EPERM**

Expo 会往用户目录写状态文件（`~/.expo/state.json`）。在写入被沙箱限制的环境里，把
`EXPO_HOME` 指到仓库内即可：

```powershell
$env:EXPO_NO_TELEMETRY = "1"; $env:CI = "1"; $env:EXPO_HOME = "$PWD\.expo-home"
npx expo export --platform web --output-dir dist
```

## 发布与运维

完整过程、平台坑与回滚步骤记录在 [docs/ops-deployment.md](docs/ops-deployment.md)。两条最常做的操作：

- **停发布**：把仓库变量 `DEPLOY_ENABLED` 改成 `false`。这是唯一开关，不删代码、不删 job、不删凭据。
- **确认线上就是我测过的那份**：`npm run export` 末尾会打印 `dist/index.html` 的 sha256；
  冒烟的 `S1` 断言比对服务端字节；`check-deploy.mjs --dist=dist` 比对线上与本地产物。
