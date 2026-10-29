# ADR-0006: 撤回「零外发」全称宣称 —— URL 拉取成为唯一由用户显式发起的外发；E1–E5 降级为默认行为基线

- 状态：已采纳（Accepted）
- 日期：2026-10-29
- 相关：ADR-0001（纯前端无后端；本 ADR 撤回其「每个请求都同源」的宽宣称，约束 1「源码不出浏览器」仍成立）、ADR-0003（audit:egress 门扫描范围扩至 pull 模块）

## 背景

新需求：允许用户给出 URL（典型是 GitHub）把文件拉进会话，替代/补充本地上传。
这个功能必然让浏览器发出跨源请求，而本站的立身宣称是全称的「零外发」
（README 三语：所有请求同源、全 GET、零请求体；browser-verify 门 E1–E5 逐条断言；
上传面板 "Code never leaves the browser"）。二者不可同真，必须有人让步。

## 决策

**撤销「零外发」全称宣称，新增「拉取（pull）」功能；护栏机制原样保留，语义从
「承诺面取证」降级为「默认行为基线」——没有用户显式拉取动作时，应用必须零跨源请求。**

具体选择：

1. **功能面**：单文件直链（任意主机）、GitHub 页面 URL（repo/tree/blob）识别、
   仓库/目录级勾选清单（只列 .py/.pyi，带体积，超 1MB 置灰，会话 20 文件上限封顶）；
   仅公开内容，不支持 token/私有库。批次 = 一个 URL，刷新按批次重放「仍在会话中的
   该批路径」；页面加载/快照还原永不自动拉取。
2. **CSP**：`connect-src 'self'` → `'self' https:`。任意主机直链使主机白名单失去意义，
   放宽到协议粒度；`http:` 无需写（https 页面的混合内容本来就被浏览器拦死）。
   `Referrer-Policy: no-referrer` 等其余头不动。改 `_headers` 后必须重跑
   browser-verify + `check-deploy.mjs --mode=browser` 验「声明 == 生效」。
3. **宣称分流**：宽宣称删除（"每个请求同源/永不离开机器"）；窄事实保留——
   拉取请求全 GET、请求体恒空，**代码内容从不被发往任何地方**，外发的只有用户亲手
   输入的 URL。UI 按钮 "Pull from URL"，代码层统一 `pull`/`pulled`（`import` 一词已被
   Python import 语句独占，见 CONTEXT.md）。
4. **取证面**：E1–E5 保留为主冒烟（不含拉取动作）的基线断言；新增 **F 组（拉取面取证）**
   四条（见「回归基线」）。F 组用本地同源桩：browser-verify 静态服务器加 mock 端点，
   pull 模块支持仅冒烟/dev 生效的 base URL 覆盖参数；真 GitHub 只做人工抽测，CI 不依赖外网。
   `audit:egress` 扫描范围扩至 pull 模块，其 `fetch(` 以 `--allow-token` 显式申报为合法外发点。

## 备选方案与为什么不选

- **保承诺 + 最小主机白名单**（只放行 api.github.com / raw.githubusercontent.com）：
  被「任意主机单文件直链」能力否决——任何直链都要 `https:` 粒度，白名单名存实亡；
  且用户明确选择撤销宣称而非改写为豁免。
- **不做此功能**：不满足需求，放弃。
- **Cloudflare Pages Functions 做代理**：等于事实上的后端，违反 ADR-0001「无后端」；
  用户输入的 URL 与取回内容将流经边缘服务器，宣称降的不止一档；匿名限速/配额反而新增。
  实测 GitHub raw/api 均带 `Access-Control-Allow-Origin: *`，浏览器直连可行，代理没有必要。

## 后果

- README 三语、上传面板 hint、ops 文档相关段落需在实现期改写（本 ADR 不代写）。
- 生产 CSP 从「什么都拦」退为「只限协议」：若页面将来被注入第三方脚本，外泄不再被
  connect-src 硬挡——防线只剩 audit:egress 与 E/F 组冒烟。这是本决策付出去的代价。
- 中国大陆网络对 GitHub 的可达性不由我们保证；报错必须分类（网络不可达 / 被 CORS 拒 /
  4xx（含限速，提示稍后再试）/ 非法 URL），文案避免被误读成"站点坏了"。

## 证据（2026-10-29 实测）

- `https://api.github.com`、`https://raw.githubusercontent.com/...` 响应均带
  `Access-Control-Allow-Origin: *` —— 纯前端直接 fetch 可行。
- `git/trees/<ref>?recursive=1` 单次匿名请求列全仓库（每项含 size）：
  cpython main 实测 6374 entries、`truncated=false`；`truncated=true` 时 v1 报错
  并提示改用目录级 URL，不做 Contents API 兜底。
- 匿名限速实测 `limit=60`，与文档一致；一次仓库导入 ≈ 1 个 API 请求 + ≤20 个 raw 请求。

## 回归基线（F 组，随实现落地）

1. 拉取场景内所有请求全 GET、零请求体；
2. 每个出站 URL 要么为用户输入原文、要么可从中确定性推导（blob→raw、repo→tree API），
   URL 不含任何文件内容；
3. 拉取完成后的静默期新增请求数为 0（自动重拉即回归失败）；
4. 刷新一个批次只产生该批次路径集的请求，不触碰其他批次。