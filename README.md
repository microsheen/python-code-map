# code-map — Python 函数调用关系图可视化

上传一个或多个 `.py` 文件，在浏览器里看到它们的函数调用关系图，左边代码、右边图，两边点击互相定位。

- **纯前端、零上行**：没有后端服务，没有账号，没有数据库，没有第三方脚本或统计。源码只在浏览器里
  解析，不作为任何请求的一部分离开这台机器 —— 这不是口号，是真浏览器门禁里的逐条断言
  （每个请求都是同源、都是 GET、请求体为空、URL 里没有你的文件名或代码片段）。
- **会话只存在你自己的机器上**：文件内容写入浏览器本地 IndexedDB（库 `code-map` /
  store `session` / key `current`），刷新页面可恢复；点 Clear 或清除站点数据即彻底删除，
  服务端永远看不到它。
- **真语法解析**：用 tree-sitter（WASM）解析 Python，不是正则扫行 —— 嵌套 `def`、类方法、
  `async def`、装饰器、相对导入都能正确识别。
- **技术栈**：Expo SDK 57 + React Native Web + react-native-svg + dagre 布局 + zustand。

两个关键设计决策记录在 ADR 里，改代码前建议先读：

- [ADR-0001 纯前端 + tree-sitter WASM，不引后端/Pyodide](docs/adr/0001-expo-rn-web-no-backend.md)
- [ADR-0002 保守的调用解析与 reason 分类](docs/adr/0002-conservative-call-resolution.md)

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
`fixtures/main.py`、`fixtures/shapes.py`、`fixtures/utils.py`。

## 界面

```
┌─────────────────────────── 顶部工具栏 ───────────────────────────┐
│ 上传  文件 chips（可单独移除）  范围: 邻域/本文件/全部  外部调用开关  │
│ 统计: 函数数 / 边数 / 未解析数 + byReason    告警条（坏文件降级）     │
├──────────────────────────┬───────────────────────────────────────┤
│  左：代码                 │  右：调用关系图                        │
│  文件标签页               │  dagre 分层布局（从左到右）             │
│  语法高亮 + 行号          │  节点按所属文件着色，角标=未解析调用数    │
│  函数名/ƒ 标记可点击       │  滚轮缩放、拖拽平移、+ / − / 适应窗口    │
└──────────────────────────┴───────────────────────────────────────┘
```

中间的分隔条可以拖拽（左右比例限制在 25%~75%）；窗口宽度小于 900px 时自动改成上下堆叠。

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

## 手动验收清单

```bash
npm run web
```

上传 `fixtures/` 里的 `main.py`、`shapes.py`、`utils.py`（三个一起选），逐项确认：

- [ ] 顶部状态显示解析完成，统计约为 **函数 45 / 边 47 / 未解析 28**
      （`ambiguous 1 / external 14 / dynamic 13 / unknown 0`）—— 与 ADR-0002 的基线一致
- [ ] 右侧出现调用图，节点按文件着色，底部有文件色图例
- [ ] 能看到跨文件的边：`main.py::boot → utils.py::load_config`
- [ ] 能看到递归自环：`main.py::factorial` 指向自己
- [ ] **图 → 代码**：点 `utils.py::load_config` 节点 → 左侧切到 utils.py、滚到第 52 行、
      函数体有高亮带
- [ ] **代码 → 图**：点 main.py 第 22 行 `def boot():` 的函数名 → 右侧把 `boot` 居中并高亮
- [ ] **调用点跳转**：点 main.py 第 24 行 `cfg = utils.load_config(...)` 里的名字 →
      选中的是 `utils.py::load_config`（被调方），不是 `boot`
- [ ] 缩放平移：滚轮以光标为锚点缩放、拖拽空白处平移、`+` / `−` / 适应窗口按钮都正常
- [ ] 范围切换：邻域 / 本文件 / 全部 三档都能切，「全部」下节点多时顶部出现大图提示
- [ ] 「外部调用」开关打开后出现一个灰色的 `builtins / 3rd-party` 聚合节点，关掉后消失
- [ ] 移除单个文件：点 `utils.py` chip 上的 × → 该文件相关的节点与跨文件边一起消失，
      左侧文件标签页同步移除，当前选中若指向被删文件则被清空
- [ ] 错误隔离：再上传 `fixtures/broken.py`（故意语法错误）→ 顶部出现黄色告警条并点名
      broken.py，其余三个文件照常出图，整个流程不崩
- [ ] 大文件滚动流畅：上传一个几千行的文件，快速滚动代码区不掉帧
      （代码区是窗口化渲染，只画可视区间 ± 24 行）
- [ ] 刷新页面 → 文件与图还在（从本机 IndexedDB 恢复）；点 Clear 后再刷新 → 干净无残留

上面**加粗的三组核心项**（图 → 代码、代码 → 图、调用点跳转）已经自动化了，
改交互逻辑时优先跑 `node scripts/browser-verify.mjs`，见下一节。

## 浏览器自动化验收（真 Chrome + CDP）

jest + jsdom 测不出「闪烁高亮在真实 rAF 下淡出」「SVG 节点能不能被真实鼠标点中」这类问题
（提交 `d0f0832` 修的正是这种只在真浏览器里复现的 bug），所以另配了一个真浏览器脚本：
headless Chrome + 原生 CDP 协议，**不依赖 playwright / puppeteer**，本机装了 Chrome 或
Chromium 就能跑。

```bash
npm run export                  # 先产出 dist/
node scripts/browser-verify.mjs # 39 项断言（含 8 项承诺面），全绿退出码 0
```

脚本自己起一个静态服务器托管 `dist/`，并把 `dist/_headers` 里的规则原样套到每个响应上
（冒烟跑的正是线上那一套 CSP）。端口被占用时会复用已有服务，但先校验两件事：那个端口上跑的
确实是本应用（判据是 HTML 里带着本项目 Metro 的入口脚本标签，**不用 `<title>`**，标题一改
就会误判），且服务端字节与 `dist/index.html` 完全一致。然后拉起 headless Chrome，把
`fixtures/` 三个文件喂进去，**用真实鼠标事件**点击 SVG 节点与代码 token，逐项断言：

| 组           | 覆盖                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| 上传         | 没有红色致命错误条；图渲染出来（基线 45 节点 / 47 边）                                                  |
| A 图 → 代码  | 切文件、滚到 `def` 行且完整可见、高亮带落在 `def` 行；闪烁出现 → 峰值 → 淡出 → 卸载；重复点击能重新触发 |
| B 代码 → 图  | 目标节点居中（偏差 < 40px）、描边加粗；代码 → 图方向**不**闪烁                                          |
| C 深层跨文件 | 从 `shapes.py` 跳到 `utils.py:95`，滚动量、高亮带位置、闪烁都对                                         |
| D 语义点击   | 点调用点选中的是被调方；点函数体中间行选中的是所在函数                                                  |
| 稳定性       | 控制台无 error、页面无未捕获异常                                                                        |
| S 产物一致性 | 服务端返回的字节 == `dist/index.html` 的字节（sha256 相同）；响应头里真的带着 `_headers` 的 CSP；产物 HTML 里零绝对 URL |
| E 承诺面     | 全部请求同源 / 全部 GET / 零请求体 / 无 4xx·5xx / 每个 200 都对应 `dist/` 里真实存在的文件 / 跑的就是 `dist` 那个入口 JS / URL 里没有用户内容 / 生产 CSP 下零 `securitypolicyviolation` |

可选环境变量：

| 变量               | 默认     | 作用                                                               |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `CODEMAP_PORT`     | `8099`   | 静态服务端口；被占用时复用已有服务（会校验字节与 `dist` 一致且确为本应用） |
| `CODEMAP_CDP_PORT` | `9333`   | Chrome 远程调试端口                                                |
| `CHROME_PATH`      | 自动探测 | 浏览器可执行文件路径（Windows / macOS / Linux 常见位置都会试一遍） |

截图（`codemap-shots/01-initial.png` … `06-deep-crossfile.png`）与 JSON 报告
（`codemap-verify-report.json`）都写在系统临时目录，不入库。跑完脚本会关掉自己起的服务器。

## 命令

| 命令                              | 作用                                                    |
| --------------------------------- | ------------------------------------------------------- |
| `npm run web`                     | 启动 dev server（自动同步 wasm）                        |
| `npm run export`                  | 生产导出到 `dist/`：preexport 同步 wasm，postexport 剥掉 HTML 注释并自检产物 |
| `npm run copy-wasm`               | 只同步 + 冒烟校验 wasm；加 `-- --no-verify` 跳过校验    |
| `npm test`                        | jest 全量测试                                           |
| `npm run typecheck`               | `tsc --noEmit`（strict）                                |
| `npm run lint`                    | eslint                                                  |
| `npm run format`                  | prettier 写入                                           |
| `npm run verify`                  | typecheck + lint + test，提交前跑这个                   |
| `npm run smoke`                   | 真 Chrome + CDP 自动化验收（先 `npm run export`）        |
| `node scripts/browser-verify.mjs` | 同上，直接跑脚本                                        |

## 目录结构

```
app/                      expo-router 入口（单页）
public/
  _headers                线上响应头（CSP / 缓存 / HSTS），`expo export` 会整目录拷进 dist/
  robots.txt              允许被检索（改成 Disallow: / 即全站禁抓）
  wasm/                   两个 .wasm（由 copy-wasm 生成，不入库）
scripts/
  copy-wasm.mjs           同步 wasm + Node 冒烟校验
  polish-dist.mjs         导出后处理：剥 HTML 注释 + 结构自检 + 零绝对 URL 自检
  browser-verify.mjs      真浏览器（headless Chrome + CDP）验收脚本
.github/workflows/
  ci-and-deploy.yml       门禁 -> 浏览器冒烟 -> 部署，三个 job 共用同一次构建的产物
fixtures/                 测试样例（main/shapes/utils/broken）
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
    scope.ts              邻域 / 本文件 / 全部 三种裁剪 + external 聚合
    layout.ts             dagre 包装（纯函数，LR 分层，输出坐标与边路径）
  state/store.ts          zustand：files / graph / selection(+nonce) / scope / view / split
  components/
    AppRoot.tsx           装配 + wasm 加载失败的红色错误条
    TopBar.tsx            上传、文件 chips、范围切换、统计、告警条
    SplitLayout.tsx       左右分栏 + 可拖拽分隔条 + 窄屏堆叠
    CodePane/             文件标签页 + 窗口化代码视图 + 可点击范围计算
    GraphPane/            SVG 图：平移缩放、节点/边渲染、高亮与降透明
    UploadPanel/          空态：选择文件 + 拖放区
  platform/web/           唯一的 DOM 触点：文件选择/拖放、非被动 wheel 与指针监听
  theme.ts                深色主题色板、字体、间距
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
| **纯函数单测**     | `modules` / `imports` / `scope` / `layout` / `buildGraph` / `store` / `clickRanges` / `graphPaneMath` / `codeView` / `smoke` | 否（用 `treeLike` 接口喂假语法树） |
| **组件与交互**     | `appFlow.test.tsx` / `topBar.test.ts`                                                                                        | 否（预置 store）                   |
| **真 wasm 全链路** | `parser.wasm.test.ts` / `imports.wasm.test.ts` / `e2e.wasm.test.tsx`                                                         | 是                                 |

`public/wasm/*.wasm` 不存在时，第三层会**整体跳过**而不是失败（`describeWasm` 助手），
这样即便安装时带了 `--ignore-scripts` 也能先把前两层跑完。想跑全量：先 `npm run copy-wasm`
（正常 `npm install` 已由 `postinstall` 自动完成）。

`e2e.wasm.test.tsx` 是最接近真实使用的一份：真 wasm 解析 fixtures → `store.loadFiles` →
渲染 `AppRoot` → 真点击，覆盖上面验收清单里的两条核心定位路径、坏文件降级、移除文件同步。

改解析规则时注意 `fixtures/` 的统计基线（函数 45 / 边 47 / 未解析 28），
数字变了要能解释原因，别顺手改测试。

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
