# ADR-0001: 纯前端 Expo + React Native Web，用 tree-sitter WASM 在浏览器内解析 Python

- 状态：已采纳（Accepted）
- 日期：2026-09
- 相关：ADR-0002（保守的调用解析）
- 修订：Amendment（2026-10，见文末）推翻了下面的决策 4（持久化），其余决策不变
- 修订：ADR-0006（2026-10-29）撤回本文「零外发/每个请求同源」的全称宣称并降级为默认行为基线；约束 1「源码不出浏览器」仍然成立（拉取为 GET、请求体恒空）。历史正文未改动。

## 背景

需求形态很明确：一个网页，上传一个或多个 `.py` 文件，左边显示代码、右边显示函数调用关系图，
两边点击可以互相定位。除此以外还有几条从需求里推出来的硬约束：

1. **源码不出浏览器。** 要分析的是内部业务代码，把源码 POST 到某个服务上再返回结果，
   在合规上是不可接受的默认行为。
2. **零部署、零运维。** 这个工具的价值是"随手打开看一眼调用关系"，不值得为它维护一个后端。
3. **解析必须真懂 Python 语法。** 需求里的"各个函数的调用关系"包含嵌套 `def`、类方法、
   `async def`、装饰器、`from .mod import x` 这类相对导入。正则或行扫描无法正确处理
   嵌套作用域、字符串字面量里的 `def`、跨多行的函数签名。

## 决策

**整个应用是一个纯静态前端，解析在浏览器里用 WASM 完成，没有任何后端。**

具体选择：

1. **运行时：Expo SDK 57 + react-native-web，只构建 Web 目标**，`expo-router` 单页（`app/index.tsx`）。
   UI 全部用 RN 原语（`View` / `Text` / `Pressable`）加 `react-native-svg`，不写 DOM 组件；
   唯一直接接触 DOM 的代码被关在 `src/platform/web/`（文件选择、拖放、非被动 wheel 监听） behind 接口。
   这样同一套组件树未来若要编到原生端，改动面是可控的。
2. **解析器：`web-tree-sitter`（WASM）**，语法包用 `@vscode/tree-sitter-wasm` 里的 `tree-sitter-python.wasm`。
   选 tree-sitter 而不是别的，是因为它天生容错：**语法有错的文件也能产出部分语法树**，
   于是"某个文件写坏了"可以降级成一条告警而不是整次上传失败。
3. **wasm 供应方式：`scripts/copy-wasm.mjs` 把两个 `.wasm` 同步到 `public/wasm/`（不入库），
   并在 Node 里当场跑一次 `Parser.init` + `Language.load` + `parse` 的冒烟校验。**
   `preweb` / `preexport` 会自动触发它，所以 `npm install && npm run web` 就是完整的启动路径。
   - 核心运行时取 `web-tree-sitter` 包自带的 `web-tree-sitter.wasm`，**不能**用
     `@vscode/tree-sitter-wasm` 里那份：后者由 tree-sitter-cli 0.25 编译，向宿主索要的
     emscripten 胶水符号（`_emscripten_memcpy_js`）与 web-tree-sitter 0.27 的 JS 端不一致，
     `Parser.init()` 会直接 `LinkError`。语言 wasm 只导出 `tree_sitter_python`，
     靠 `LANGUAGE_VERSION` 兼容检查加载，用 VS Code 持续维护的预编译产物是安全的。
   - 浏览器侧语言包走 `fetch → arrayBuffer → Language.load(bytes)`，绕开某些静态托管对
     `.wasm` 的 MIME 配置问题。
4. **不持久化。** 不写 localStorage / IndexedDB，刷新即清空，会话内存里待着。
   > ⚠️ 本条已被文末 **Amendment（2026-10）** 推翻：现在会写本机 IndexedDB。原文照抄保留，
   > 因为「当初决定不持久化」本身就是这条 ADR 的一部分。
5. **解析在主线程分批执行**（每批 3 个文件，`await` 让出主线程），进度显示 `已解析 i/N`；
   单个文件失败只标记该文件 `error`，其余照常出图。

## 备选方案与为什么不选

| 方案                                                 | 为什么没选                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Pyodide**（浏览器里跑 CPython，用 `ast` 模块解析） | 首次下载 10MB+，冷启动秒级到十秒级，对一个"随手看一眼"的工具太重；而且我们只需要静态语法分析，不需要 Python 的执行语义。 |
| **后端服务 + Python `ast`**                          | 精度确实最高（可配合 `ast` 的完整语义），但引入部署面、跨域配置，以及最要命的：源码要离开浏览器。与约束 1 直接冲突。     |
| **纯正则 / 行扫描**                                  | 无法正确处理嵌套作用域、字符串里的 `def`、装饰器、多行签名。做出来是个会骗人的工具。                                     |
| **自写 Python 解析器（JS）**                         | 工作量与长期维护成本远超收益，且几乎必然比 tree-sitter 的容错性差。                                                      |

## 后果

**正面**

- `npm install && npm run web` 就能跑，没有服务端、数据库、密钥、跨域配置。
- 源码全程留在这台机器的浏览器里（内存 + 本机 IndexedDB），可以直接拿去分析内部代码。
- 静态导出（`npm run export`）后就是一堆可以扔到任意静态托管 / 内网文件服务器上的文件。
- tree-sitter 的容错性让"部分文件坏了"成为可表达的降级状态（`warnings`），而不是全有或全无。

**负面 / 需要长期背负的成本**

- **wasm ABI 配套是一个长期维护点。** `web-tree-sitter` 与语言 wasm 的版本必须匹配，
  升级任一方都要重跑 `npm run copy-wasm` 的冒烟校验（见 tree-sitter#5171 一类问题）。
  这也是我们在 `package.json` 里把这两个版本**精确锁定**（不用 `^`）的原因。
- **没有类型信息。** tree-sitter 只做语法层解析，`obj.method()` 里 `obj` 是什么类型它不知道。
  这直接导致调用解析必须走保守路线 —— 见 ADR-0002。
- **主线程解析有规模上限。** 几十个文件毫无问题；上千文件的大仓会卡 UI。
  Web Worker 是已经预留好的优化位（解析管线全部是纯函数，可整体搬进 worker），但默认不启用，
  以免 worker 打包问题阻塞交付。
- **RN Web 的事件模型有摩擦。** `onWheel` 在 react-native-web 上是被动监听，`preventDefault` 无效，
  页面会跟着滚。解决办法是在 `src/platform/web/domEvents.ts` 里用非被动监听自己接管，
  RN 层只负责渲染。这类"必须穿透到 DOM"的地方要一直收敛在 `platform/web/` 里。
- 只支持 `.py` / `.pyi` 文本文件，单文件按 1MB 上限处理（超出提示跳过）。

## Amendment（2026-10）：会话持久化到本机 IndexedDB

- 状态：已采纳，**修订决策 4**（其余决策不变）
- 触发需求：「刷新网页时应该能记住当前的文件选择，而不会完全回到初始页面」。

**改了什么。** 新增 `src/platform/web/persist.ts`，`store.loadFiles()` 成功后 `void saveSession(...)`，
`AppRoot` 挂载时 `void restoreSession()`，TopBar 的 Clear 调 `clearSession()`。存储位置是
**浏览器本地 IndexedDB**（库 `code-map` / version 1 / store `session` / key `current`），
值为 `{ files, activeFile, timestamp }`，即**全部文件内容**都在里面。所有读写包在 try/catch 里
静默降级，IndexedDB 不可用时应用照常工作。

**为什么这不算违反原始约束。** 约束 1 说的是「源码不出浏览器、不作为请求的一部分离开机器」，
判定标准是网络行为而不是存储 API。IndexedDB 是同源本地存储，数据不经过网络，
且发布路线的门禁断言的是「每个请求都同源、都是 GET、零请求体、URL 里没有用户内容」——
持久化不改变任何一条。真正需要改的是**对外文案**：README 与 ADR 原文都写着「不落任何持久化存储」，
那是错的声明，比持久化本身危害大。

**新引入的成本（必须一起接受）**

- 文件内容在磁盘上留到用户主动 Clear 或清除站点数据为止。任何共享/公用机器上都算残留，
  所以 Clear 按钮是隐私路径而不是整理界面的糖。
- **apex 与 `www.` 是不同的 origin，因此是不同的 IndexedDB 命名空间。** 同一份会话会被分裂成两份，
  这是数据完整性问题，不是美观问题 —— 绑域名时必须用一条 301 把 `www.*` 收敛到 apex。
- 持久化内容进入 `dist` 之外的浏览器存储，冒烟测试不能替用户删除它；验收清单里
  「点 Clear 后再刷新 → 干净无残留」是这一条的唯一人工保障。
