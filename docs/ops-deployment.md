# 发布与运维记录（code-map → Cloudflare Pages）

> 这份文件只写**机制与平台行为**。凭据值、账号 ID、内网主机名一律不进仓库、不进 git 历史、
> 不进这份文档 —— 它们只存在于 CI secrets/variables 与本机环境变量里。
> 标 **[实测]** 的是在本项目某次具体运行中拿到数字的事实，带时间戳；平台会变，动它们之前重测。

## 1. 对外承诺（可验证的那三条）

| 承诺 | 怎么被证明 | 谁拦着 |
| --- | --- | --- |
| 源码不上行 | 真浏览器里逐个请求断言：全同源 / 全 GET / 零请求体 / URL 里不含任何用户内容标记 | `browser-verify.mjs` E1–E7（CI 必过） |
| 无第三方代码 | 产物 HTML 里**零个** `https?://`（含被剥掉的注释）；线上新增第三方引用按 counted finding 处理 | `polish-dist.mjs` + `check-deploy.mjs` |
| 没有服务端存储 | 托管是 Direct Upload 的纯文件站点，没有 Functions / KV / D1 / DO | 选平台时就决定了 |
| 会话只在你机器上 | 写本机 IndexedDB（`code-map` / `session` / `current`），Clear 即删 | ADR-0001 Amendment |

第三条是"host 物理上没有写的能力"，比任何"我们不会滥用"的承诺都强。代价是必须能设响应头，
所以 GitHub Pages 出局（它不能设 CSP）。

## 2. 发布管道

`.github/workflows/ci-and-deploy.yml`：`checks → browser-smoke → deploy`，三个 job 共用
**同一次构建的产物**（`upload-artifact` / `download-artifact`）。第二次构建出来的不是同一份字节，
门禁就白跑了。`deploy` 用 `needs` 硬依赖前两个 job。

- 端到端顺序：`npm ci` → `npm run verify`（typecheck + lint + jest）→ `npm run export`
  （`preexport` 同步 wasm，`postexport` 剥 HTML 注释并自检）→ 产物结构断言 →
  在 headless Chrome 里跑 `npm run smoke` → `wrangler pages deploy`。
- `browser-smoke` 只下载 artifact、不装 `node_modules`，跑的是和线上同一套 `dist/`。
- **门禁红了只许改 app 或改 flake，不许加 `continue-on-error`、不许删 `needs`。** 一个能被我随手
  关掉的绿灯不是合同。
- 部署地址**只从 deploy 步骤自己的 stdout 里取**：
  `✨ Deployment complete! Take a peek over at https://<id>.<project>.pages.dev`。
  Direct Upload 的部署 id 是 ~8 位 hex，**不存在**按 commit SHA 拼出来的主机名；
  也不要拿"部署列表里最新一行"代替 —— 并发推送时那可能是别人的部署。
  取不到就打 warning，不猜。

**本轮补上的两条静默失效防线**

1. **`permissions:` 的作用域陷阱。** 官方原文：
   "If you specify the access for any of these permissions, all of those that are not
   specified are set to none."（[实测·原文] docs.github.com / workflow-syntax）。
   写了 `contents: read` 就等于把**没写出来的 scope 全部降为 none**，而三个 job 之间传
   `dist/` 靠 Actions artifact —— 归 `actions` scope 管。少了 `actions: write`，4 处
   artifact 操作（checks 上传 dist、browser-smoke 下载 dist + 上传证据、deploy 下载 dist）
   预期会红在第一步，报 `403 Resource not accessible by integration`。
   **[推断]** —— 首跑（2026-10-13）红在第 4 步 `Install from lockfile`，**没走到**任何 artifact 操作，
   所以这条 403 预测至今既没被证实也没被证伪；`actions: write` 已在 `permissions:` 块里，要等下一次真跑
   走到 upload 那一步，才有资格改口。
   修法只加 `actions: write`，**没有**改成 `read-all`/`write-all`：那等于把这次显式声明作废。
   同一页另一句 "write includes read" 说明下游两次 download 也被这一条覆盖。
2. **生产分支名硬编码在两处** —— `env.PRODUCTION_BRANCH` 与 `deploy` 的 job 级 `if`
   （job 级 `if` 读不到 `env` 上下文，GitHub 的已知限制）。两处一旦不同步，后果**不是红灯**：
   `if` 永远为 false ⇒ 构建全绿、冒烟全绿、什么都没发布、没有任何报错。已把它从"注释里的提醒"
   升级成 `checks` 里的断言：`grep -cF "github.ref_name == '<生产分支>'"` 必须**恰好 1 次**。
   [实测] 本机 Git Bash 跑过三种情形：两处一致 -> `n=1` 绿；**只改 env** -> `n=0` 红 exit 1；
   两处一起改 -> `n=1` 绿。2026-10-13 生产分支正式定为 `main`：`env.PRODUCTION_BRANCH` 与 `deploy`
   的 `if` 两处同步改完，改完复跑断言 = `n=1`，`'master'` 残留 0 次。
3. **仓库归属守卫（O1）必须出现在三个 job 上。** job 级 `if` 同样读不到 `env`，所以
   `github.repository == '<公开仓坐标>'` 这个字符串被抄了三遍。少抄一处的后果**不是红灯**，而是内网
   GHES（`runners = 0`，见 §12）重新为每次 push 排一条最长 24 小时的僵尸 run。所以这是第二条断言：
   `grep -cF` 该字符串必须**恰好 3 次**。[实测] 本机 Git Bash：`guard=3` / `ref_name_main=1` /
   `ref_name_master=0`；另用 `js-yaml` 解析过整份文件，三个 job 的 `if` 与 `deploy` 的四个条件都在。
   注意 workflow 级 `if`（写一处就全局生效）**不是** workflow-syntax 记录在案的顶层键（那一页的锚点里
   查不到 `if`），所以只能三处抄；而写一个不认识的顶层键会让整份 workflow 解析失败，比僵尸 run 更糟。

4. **锁文件由指定的那个 npm 生成，CI 必须把 npm 钉到完整版本号。** 这条结论改了两次才对，两次都留着，
   因为它是"本地绿 ≠ CI 绿"的标准样本，也是我一次把错误结论写成定论的样本。
   - **首跑**红在 `npm ci`：`Missing: @emnapi/core@1.11.3 / @emnapi/runtime@1.11.3 /
     react-native-worklets@0.10.4`。我当时判定"npm 10 与 npm 11 对可选平台依赖解析不同"，依据是本机
     `npx npm@10 ci --dry-run` exit 1 报同样三条。**该结论只对 `react-native-worklets` 那一条成立。**
   - **第二次跑**（已把 `node-version` 22→24、并断言 npm 主版本 = 11）仍红，缺的还是那两条
     `@emnapi/*` —— 大版本相同也会红，说明上一条的根因不充分。而 `react-native-worklets` 不再出现。
   - **现在的结论**：runner 的 `node-version: '24'` 解析成 **node 24.21.0 / npm 11.19.0**（[实测] 取自
     该 run `Toolchain` step 打印的 `node=… npm=… lockfileVersion=3`），本机是 **24.12.0 / npm 11.6.2**。
     [实测] 本机 `npx npm@11.19.0 ci --dry-run`（Windows，不带任何 `--os/--cpu`）**完整复现** CI 的失败，
     同一份锁在 11.6.2 下 exit 0。**是 npm 小版本差异，与操作系统无关。** 因此先前四轮
     `--os=linux --cpu=x64` / `win32` / `darwin arm64` / `wasm32` 的复刻尝试方向就是错的，
     "这条本地永远验不出来"也不成立 —— 只要把 npm 换成 runner 那一个版本，本机就能红。
   - 机制（读锁文件得到的事实）：`@napi-rs/wasm-runtime` 把 `@emnapi/core|runtime` 声明为
     **peerDependencies**，它自己挂在 `cpu=wasm32` 的可选子树里；锁中只有
     `node_modules/@unrs/resolver-binding-wasm32-wasi/node_modules/@emnapi/{core,runtime}`
     这份 1.10.0 的**嵌套副本**，**没有顶层条目**。npm 11.19.0 构树时要求补齐顶层 peer，锁里没有
     → `EUSAGE`。npm 10 报的 `react-native-worklets@0.10.4` 是同一类缺口的另一处表现（锁里记 0.12.2）。
   - **复发条件（最该记住的一句）**：[实测] 本机 npm 11.6.2 跑 `install --package-lock-only` 会把那两条
     顶层条目**重新剪回去**（1137 → 1135），锁又变回 CI 装不动的那份。所以重新生成锁只能用
     `npx npm@11.19.0 install --package-lock-only`；`checks` 里的断言也从"主版本 11"升级为
     **完整版本 `11.19.0`**，不符先 `npm install -g npm@11.19.0` 再复核 —— 不再赌 node 小版本自带哪个 npm。
   - 为什么算发布门禁而不是"装不上而已"：换 npm 就是换依赖树，门禁验的字节与线上发的字节不再是同一次
     构建的产物，这是 tested≠shipped 的隐蔽形态。
   - [实测] 补齐后的核对（全部本机跑过，不是推断）：`npm ci` 用 11.19.0 真实安装（含 root postinstall
     copy-wasm）exit 0，`added 1096 packages`；`npm run verify` = 15 suites / 225 passed / exit 0；
     `npm run export` 产物 26 个文件，与修复前的 dist **哈希集合与路径集合都完全一致**；锁文件 diff
     仅新增 `node_modules/@emnapi/{core,runtime}@1.11.3` 两条（`optional`+`dev`），无删除、无版本变动、
     无 `resolved` 变动 —— 所以"产物不变"是被比出来的。11.19.0 安装时报 `unrs-resolver` 的 postinstall
     未被 `allowScripts` 覆盖（warning，非 error），verify 仍全绿。
    - [实测] **`deploy` 已于 2026-10-13 第一次真实执行并通过**（run `38359980657`，`workflow_dispatch`
      触发在 `main` / `0a3e0cf`；同日 `push` 触发也已跑通，见 §13 的 `38364378715` —— 两种触发方式都实测过了）：
      wrangler 4.149.0 用 Actions secrets 里的 token 鉴权通过，
      `download-artifact` 在 `actions: write` 下取回了 `checks` 上传的那一个产物，URL 从 stdout 的
      「✨ Deployment complete! Take a peek over at …」一行解析成功 —— 原先记在本条的那个边界已被这次运行作废。
      `project create` 这次走的是**已存在**分支（日志里是 `8000002 A project with this name already
      exists` 紧跟 `project 已存在，继续`，不是权限故障）；**首次创建**分支由同一天本机直连 API 建项目时
      验证过 —— 两条分支各自都有过一次真实执行了。归属守卫 O1 是另一件事（§12），已于同日另一次推送实测，
      两边不要混用成同一个开关。仍然没被实测过的只剩 `vars.DEPLOY_ENABLED` 的**回退**：`true → false`
      真能止住发布、再翻回 `true` 又能发。
   - [实测] CI 报 `added 1098 packages`、本机 `npm ci` 报 `added 1096`，这 2 个已对上账，不是隐患：
     同一份锁跑 `npx npm@11.19.0 ci --dry-run --os=linux --cpu=x64` 得 `added 4 / removed 2`，增的是
     `lightningcss-linux-x64-{gnu,musl}` 与 `@unrs/resolver-binding-linux-x64-{gnu,musl}`，删的是对应
     的两个 `*-win32-x64-msvc`。全是构建期用的平台专属原生二进制，不进 `dist/`，与浏览器产物无关。
     以后遇到"两边数字不同"先这样取证：既不默认良性，也不默认有问题。
**fork 的 PR 也会执行 `npm ci`。** 触发器是裸 `on: push` + `on: pull_request`（无分支/路径过滤），
`checks` 第一步 `npm ci` 会跑依赖的 postinstall，而 `pull_request` 跑的是 fork 的工作流 ——
恶意依赖能在 runner 上执行代码。建议在 Settings -> Actions -> General 打开
**Require approval for all outside collaborators**。**不改触发器**：门禁必须在 PR 上跑。

**`actions/upload-artifact@v4+` 在 GitHub Enterprise Server 上不受支持**，上游 README 原文要求
GHES 用 v3.2.2（[实测] 取自 `gh api repos/actions/upload-artifact/readme`；
raw.githubusercontent.com 本机不可达）。本仓最终落在 github.com 跑，所以留 v4；
要让同一个文件在内网实例跑，v4 是第一个炸点 —— 见 §12。

**prettier 没进门禁。** [实测] `npx prettier --check .` exit 1、**61 个文件**不干净 ——
这个仓库本来就不是 prettier-clean。加门禁等于凭空造一个必红的 CI；跑一次全量 format 又会把
可读的 diff 搅成一团。两条都不是本轮该付的代价：想要风格一致性时单独一笔做完，别混进发布门禁。

## 3. 可逆开关

| 想做的事 | 做法 | 不要做 |
| --- | --- | --- |
| 停止发布 | 仓库 **variable** `DEPLOY_ENABLED` = `false` | 删 job / 删 secret（之后会变成"看起来像鉴权失败"的错） |
| 回滚一次发布 | 控制台 Deployments → 目标行 → Rollback（或 `POST /pages/projects/<p>/deployments/<id>/history/rollback`） | 重新构建"试图复原" |
| 解绑域名 | **先**删 zone 里的 CNAME，**再**在 Pages 里 Remove domain | 反序，会留下永久 pending 的幽灵域名 |
| 彻底下线 | 不需要数据导出 —— 用户的数据本来就在各自浏览器里 | 写导出脚本 |

每个部署的 URL 永久有效，所以上线出问题时"回滚"和"把出事的那份字节拿出来看"是同一个动作。

## 4. [实测] 本房产物基线

2026-10-09 09:39–09:40 (+08:00)，本机：

```
npm run export
  entry: /_expo/static/js/web/entry-d2ba5f….js  (1.4MB)
  index.html: 1182B -> 914B（剥掉 3 段 HTML 注释）
  index.html sha256: 52eb64f4935e49d71077056fe7426a78c1d08385499fe119ec93dea595c6d071
  产物内绝对 URL 数量: 0

npm run smoke  -> 39/39 PASS，退出码 0
  S1 服务端字节 sha == dist sha
  S2 响应头带着 CSP（见下）
  S3 HTML 零绝对 URL
  E1 全部同源，总请求数 = 5
  E2 全 GET     E3 零请求体     E4 无 4xx/5xx
  E5 每个 200 都对应 dist 里真实文件
  E6 页面执行的入口 JS == dist 的入口 JS
  E7 200 个用户内容标记 × 5 个请求，零命中
  E8 生产 CSP 下 securitypolicyviolation = 0

真实请求集：GET / →200 ; GET /_expo/static/js/web/entry-*.js →200 ;
           GET /favicon.ico →204 ; GET /wasm/tree-sitter.wasm →200 ;
           GET /wasm/tree-sitter-python.wasm →200
```

> 构建产物的完整 32 位十六进制文件名**不写进文档**：它长得像 token（公开扫描会当成
> 疑似凭据报 MEDIUM），而且每次内容变化就变。记前缀足够定位，其余以当次 stdout 为准。

结论：`default-src 'none'` 起手的 CSP 下应用完全可用，**不需要** `unsafe-eval`，
只需要 `wasm-unsafe-eval`。这份 CSP 直接写在 `public/_headers`，`expo export` 把 `public/`
整目录拷进 `dist/`，冒烟服务器把 `dist/_headers` 的规则原样应用到本地响应上 —— 测的就是线上门禁。

入口 JS 文件名带 content hash，`/wasm/*.wasm` **不带** —— 这就是缓存策略分两档的原因。

**[实测] 同日独立复跑（2026-10-09 10:14–10:15，本机第二次运行，与上表基线逐字节对齐）**

| 跑的东西 | 结果 |
| --- | --- |
| `npm run verify` | exit 0；typecheck + lint（0 error / 12 warning，均为既有）+ jest **15 suites / 225 tests** 全过（13.653 s） |
| `npm run export` | exit 0；入口 `entry-d2ba5f….js`；`index.html` `1182B -> 914B`；sha256 `52eb64f4…c6d071` **与基线相同** |
| `npm run smoke` | **39/39 PASS**，exit 0；真实请求总数 **5**、全 GET、零请求体、零 4xx/5xx；`console errors = []`、`page exceptions = []` |

两次独立运行 sha256 相同 ⇒ **构建可复现**。这不是洁癖，是"一次构建、两处消费"的前提：
`browser-smoke` 和 `deploy` 下载的是同一批字节，而不是"又一次构建"——否则门禁验的和发出去的不是一回事。
`dist/` 在 `.gitignore` 里（[实测] `git ls-files dist` = 0 个文件），复跑 `export` 不会脏工作树，
也不会有人不小心把产物提交进去。

第三次独立运行就在写这段的当下：`npm run verify` 同样 15 suites / 225 tests 全过（`Time: 14.462 s`）、
lint 仍是 0 error / 12 warning。`verify` 的定义是 `npm run typecheck && npm run lint && npm test`，
jest 是链条最后一步且全绿 ⇒ 前两步必然也通过了 —— 这是从 `package.json` 读出来的，不是猜的。

## 5. `public/_headers` 与"声明 ≠ 生效"

`_headers` 里不写任何主机名，换域名是零 diff。缓存分档：

| 路径 | 声明 | 理由 |
| --- | --- | --- |
| `/index.html`、`/metadata.json`、`/robots.txt` | `max-age=0, must-revalidate` | 入口指针，必须每次问 |
| `/wasm/*` | `max-age=0, must-revalidate` | **无内容 hash**：旧 wasm 配新 JS = `LinkError` |
| `/_expo/*`、`/assets/*` | `max-age=31536000, immutable` | 文件名带 hash，可以永久 |

**[实测·平台事实] Cloudflare zone 的 Browser Cache TTL（默认 4 小时）会覆写非 immutable 的
`Cache-Control`**：别的项目里 `/sw.js` 声明 `no-cache` 回来变成 `max-age=14400`，
`/registerSW.js`、`/robots.txt`、`*.png` 同理；`/assets/*`（immutable）与 `*.webmanifest` 没被动过。
安全头在所有 host 上一致。归因是 **[inferred]**（从 `cf-cache-status` 与哪些路径变了反推，
没有读 zone 设置的权限）。

推论：**必须逐资源验证"声明 == 生效"，只比 `/` 会漏掉。** 精确修法是
Rules → Cache / Transformation Rules 对 `/wasm/*` 那几个 URI 覆写 `Cache-Control`（需要 Zone Rules
权限）；粗暴修法是缩短整个 zone 的 TTL，会连带动到全部资源。两者都不做，那么任何写着
"`/wasm/*` 是 no-cache"的文档都必须带上"声明的"这个限定词。

另外：**别拿 `ETag` / `Last-Modified` 当"是不是我那份"的证据** —— 它们属于回答你的那个应答者，
不属于你的文件。[实测] 同一份 1904 B 的 HTML 在同一个 host 上一次返回 `W/"770-…"`、
另一次返回 `219a02ccb69f…`；前导数字甚至不是字节数。它们只可以用来在**同平台的两个 host 之间**
比较，永远不要拿来和本地构建产物比。

## 6. 平台会改写你发出去的东西

**[实测] Zone → Web Analytics 会往自定义域名的 HTML 里注入第三方脚本**
`<script src="https://static.cloudflareinsights.com/beacon.min.js">`，而且**只注入自定义域名，
`pages.dev` 不注入**。注入只在"浏览器形状"的请求下发生（Chrome UA + `Accept: text/html` +
`Sec-Fetch-Dest/Mode: navigate`），用 node/curl 做字节比对会看到完全一样的 HTML、彻底漏掉它。
[实测数字] 1904 B → 2271 B（+367 B）。beacon 还会向同源 `/cdn-cgi/rum` 发 `POST`，
直接打破承诺 1 和"全 GET"。当时是 CSP 挡住了它的执行，所以数据其实没出去 ——
**但 CSP 在这里是兜底，不是修法**。

文档里写的 "Automatic setup → Disabled" 开关在某些 plan 上**可能根本不存在**
（社区反馈 cloudflare/workers-sdk#14552、#15898）。真正有效的杠杆是 **Delete the Analytics site**：
它只删 analytics property，域名、Pages 项目、产物、响应头都不动，同时让已经出现在公开 HTML 里的
beacon token 失效。[实测] 删掉后注入**立刻**停止，不需要重新部署（和文档暗示相反）。
以后真想要统计，用 **Manual setup** 自己贴代码，这样 CSP 可以保持关闭状态。

**本项目的处置**：自定义域名一旦绑上，第一件事是确认该 zone 没有开启 Web Analytics /
RUM / 任何注入型 add-on；然后用 `--mode=browser` 的验证器复核（普通模式看不到注入）。

SPA history fallback：未知路径返回 **200 + index.html**，`/api/*` 也一样。没有后端在写数据，
但**看起来像有 API**，所以任何对外文档都必须写明这一点。

## 7. 域名：钱、状态、payload

- 注册域名不免费（同账号历史价 `.com` ≈ **10.46 USD/年**），**自动续费默认开启**。免费的只是
  DNS、CDN、Universal SSL、WHOIS 隐私和绑定本身。注册当天就去确认续费开关，到期日记在会看的地方；
  到期日通过 RDAP 公开可查（`https://rdap.org/domain/<name>`）。[实测] 有些机器连不上注册局自己的
  RDAP 或 `dns.google`，**先测你手上这个观测点能用哪个聚合器**，别照抄命令。
- **[实测] 绑定域名的 API 字段是 `name`，不是 `rel`。** 发 `rel` 会得到 `8000015 invalid TLD`
  —— 即使域名完全合法。这个错误信息描述的是你的输入而不是你的 payload 形状。判断方法是对照实验：
  已知好域名 + 明显假域名 + 空 body 都返回同一个码，就是形状错了。`8000018 already added`
  能证明名字确实被解析成功了。`PATCH /pages/projects/<p>/domains/<name>`（无 body）可以重跑验证，
  因此这一步是幂等的。
- **[实测] API 不会替你建 CNAME**（只有控制台向导会）。绑完是 `pending` + "CNAME record not set"，
  需要手建两条：`@` 与 `www` 的 CNAME → `<project>.pages.dev`，**`proxied: true`**、`ttl: 1`。
  灰云（direct）在 Pages 自定义域名上会得到 **525/522**，症状和"没有部署"一模一样 ——
  靠另一个 host 的表现来区分。apex 上的 CNAME 在这里合法，因为 Cloudflare 做 **CNAME flattening**
  （直接答 A/AAAA），所以 `dig CNAME <apex>` 返回 **ENODATA 是正常结果**，不是记录丢了。
  **[实测] 但「两条记录建好了」只解决 DNS，不等于两个 hostname 都在服务。** Pages 要求每个 hostname
  单独作为 custom domain 挂进项目：本项目 `domains` 只有 apex 与 `pages.dev` 两条（2026-10-13 取回），
  从没挂过的 `www` 于是拿到 `522` 而不是应用（实测细节见 §13）。它和上一条的灰云故障**同码不同因**，
  区分办法还是同一分钟里比另一个 host —— apex `200` 而 `www` `522` ⇒ 部署没坏，是这个 hostname 没挂上。
  建 DNS 记录需要 token 有 **Zone / DNS: Read + Edit**，否则 `10000 Authentication error`；
  改 token 权限**不会**换 token 字符串，所以 CI 里那个 secret 不用重新粘贴。
  HTTPS 在 Pages 翻到 `active` **之前**就能用：泛域名证书在 zone 接管域名的那一刻就覆盖了它，
  `active` 只表示 Pages 接受了归属。
- **`www` 与 apex 是不同 origin ⇒ 不同 IndexedDB 命名空间。** 两个 hostname 都在服务时，
  同一份会话会被劈成两份，这是**数据完整性**问题不是美观问题。[实测] 2026-10-13 `www` 并不服务
  （稳定 `522`，见 §13），所以这条此刻是**潜在**风险而不是现状。修法是一条 Redirect Rule：
  `www.*/(.*)` → apex，301。
  [实测] 2026-10-13 这条规则**当前这个 token 建不了**：`GET /zones/<zone>/rulesets/phases/http_request_redirect/entrypoint`、
  `.../http_request_static_redirects/entrypoint`、`.../entrypoint/entrypoint` 和 `GET /zones/<zone>/rulesets`
  **四条只读接口全部 HTTP 403 `10000 Authentication error`**，而同一个 token 打 Pages 项目、Zone DNS、Zone 详情
  都是 200 ⇒ 不是「规则还是空的」，是没有 **Zone / Rules** 权限。和上一条同理：改权限**不换** token 字符串，
  CI 里那个 secret 不用重贴。
- 保留 `pages.dev` 作为对照与回滚锚点。担心重复内容收录就在**那个 host 上**加
  `X-Robots-Tag: noindex`，而不是把它重定向走。本仓库 `robots.txt` 当前是 `Allow: /` —— 纯客户端工具被索引不会暴露任何用户内容；
  不想要检索就把那两行换成 `Disallow: /`（注意它同样只是**声明**，见 §5 的 TTL 覆写）。
- 默认**没有 HSTS**，已在 `_headers` 里自己加。

## 8. 上线后验证（观测点决定结论）

```bash
node <skill>/scripts/check-deploy.mjs \
  --hosts=https://<apex>,https://www.<apex>,https://<project>.pages.dev \
  --paths=/,/wasm/tree-sitter.wasm,/wasm/tree-sitter-python.wasm,/robots.txt \
  --dist=dist --mode=browser
```

**别把 `/index.html` 放进 `--paths`。** [实测] Pages 对 `/index.html` 返回 **308** canonical 到 `/`，
而脚本取响应时用 `redirect: 'manual'`（不跟随跳转），于是那个 308 的跳转体被拿去和 `dist/index.html`
比字节 ⇒ 必然计入 `differs from --dist bytes` 并把退出码打成 1，而线上其实是好的。`/` 已经覆盖了
同一个文件（`--dist` 的映射里 `/` 就是 `index.html`），列它两次只会多一个假阳性。

退出码：`0` 没有 counted finding，`1` 至少一个，`2` 用法错。counted 桶包括：跨 host 字节不一致、
HTML 里出现第三方引用、服务端字节与 `--dist` 不一致、counted 头不一致、**状态码跨 host 不一致**、
**任何 ≥400 的响应**（会连 `server` 头一起打）、传输错误。`--ignore-header` 只用于**已经判定为
平台差异**的头 —— 它同时会把后面几次真正由你主机应答的运行也消音。

**[实测] `pages.dev` 与自定义域名是不同的故障域。** 2026-10-13 同一分钟内 `*.pages.dev` 直连得到
`200 + server: cloudflare`（带 `cf-ray`），而刚绑定的 apex 与 `www` 在 443 上得到 13,850 / 14,935 B
的拦截页，应答方的 `server` 头是中间设备的产品名（不是 `cloudflare`）且**没有 `cf-ray`**；80 端口是 307 跳到一个企业网关主机。不涉及
DNS、证书、部署 —— 是**验证机上面的中间设备**替 Cloudflare 应答了；它按 SNI 过滤，所以拿 `--resolve`
指到 Cloudflare 的 IP 也绕不过。比较内容之前先问"谁答的"；先修观测点，再判断字节。

因此：**新的自定义域名上线后，必须换一个网络（比如手机热点）复测一次**，
不能只信办公网里那次全绿。本机跑 `--mode=browser` 时也一样：企业网关改写过 HTML 时，
本机能证明的只有"这台机器收到了什么"。

## 9. 无服务端反馈渠道

打算用 Cloudflare **Email Routing** 做接收别名 → 个人邮箱转发，零后端、不加代码路径。
纪律：

- 只开 Email **Routing**，**不开 Email Sending**（那是另一套 beta 管道：`cf-bounce.*` 记录、
  DKIM/DMARC/配额/抑制表/信誉 = 长期运维义务，而且和"无后端"立场矛盾）。
- 转发**目标地址**绝不进仓库、git 历史、文档 —— 这个映射只存在于控制台 Destination 字段里。
- 绝不建 alias → 同一个 alias 的规则（自环）。要拒信用 `Drop` 动作。
- 配额读官方 limits 页，社区帖的数字流传过期且互相矛盾。
- 回滚顺序：删 routing 规则（地址立刻失效，站点不动）→ 删 destination（引用它的规则被禁用）→
  Disable Email Routing（撤销它自己加的记录）。Pages 的 CNAME 完全不在这条路径上。
- 公开页面上放联系地址会在公开后招垃圾邮件：这是**决定推送顺序**的理由，不是砍掉渠道的理由。

## 10. 拍板台账（Phase 2 各项的当前结论）

| 项 | 状态 |
| --- | --- |
| 现有代码库内容对外公开的合规性 | ✅ 2026-10-13 用户明确「允许」 |
| 公开目标账号与仓库名 | ✅ `microsheen/python-code-map`（[实测] 此前在 github.com 上 404，即不存在同名仓库） |
| 仓库可见性 | ✅ 2026-10-13 **已翻 public**。这是全程唯一不可逆的动作，授权来源是用户对本项的「允许」；顺序为「先私有建 → CI 全绿 → 干净克隆复审计 findings 0 → 翻公开 → 匿名克隆再审计」，证据见 §13。翻公开之后内容对全网可读且随时可能被爬取归档，所以此后**每一次推 `main` 之前**都要先过 §11 的 scrub 清单与 `audit --history`，再推 |
| 公开仓库默认分支 | ✅ `main`（用户未指定，采用建议默认值；workflow 两处同步见 §2 第 2 条） |
| GHES 那份 workflow（O1–O4） | ✅ 选 O1，已实施，并于 2026-10-13 **实测通过**：推内网后 run 整体 `skipped`、不排队，见 §13 |
| LICENSE | ✅ 选 MIT（2026-10-13，agent 代拍；拍板时仓库仍是 private，现已 `PUBLIC`，要换成 Apache-2.0 或撤掉得走一次新的提交与推送）。`LICENSE` 文件已真实存在（1067 字节，LF），不是只在 README 里声称 |
| `package.json` 的 `license` / `repository.url` / `author` | ✅ 已随许可证在同一次提交里补齐：`license: MIT`、`author: microsheen`、`repository.url` 指向公开仓。真正的许可 bug 是"manifest 声称 MIT 但没有 `LICENSE` 文件"，所以两者必须一起落 |
| Cloudflare API token 与 account id | ✅ 2026-10-13 用户直接提供。只存在仓库之外的临时目录，并已写入 Actions secrets（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）；**任何一份拷贝都不进仓库、历史、文档** |
| 域名：复用已有 zone 还是新注册 | ✅ 复用账户下已有的 `python-code-map.com` zone（`status=active`、区内原本 0 条记录）。[实测] 2026-10-13 绑定完成：`POST /pages/projects/<p>/domains`（字段名必须是 `name`）成功，状态 `initializing → pending → active`；再手建两条 proxied CNAME（`@`、`www` → `python-code-map.pages.dev`、`ttl: 1`），记录由 0 条变 2 条。这一步顺带**证实了 token 有 Zone / DNS: Edit** —— §7 那条「建 DNS 记录需要 token 有 Zone / DNS: Read + Edit」的前置条件到此已由实做证实。**但办公网无法端到端验证它**，见 §8 与 §13 |
| Pages 项目名 | ✅ `python-code-map`（2026-10-13 agent 代拍，可撤销）。[实测] `POST /accounts/<acct>/pages/projects` 直接创建成功 ⇒ 这个名字**全局未被占用**，返回 `subdomain=python-code-map.pages.dev`、`production_branch=main`；`vars.PAGES_PROJECT_NAME` 已指向它。代价说清楚：项目名**不可改名**，换名的唯一路径是删项目重建 + 重绑域名 + 改变量，**已发出的 URL 会全部失效** |
| 反馈渠道 | ✅ 定为只用 GitHub Issues（2026-10-13，agent 代拍）：仓库已开 `has_issues`，零新增配置、不在页面上公开任何邮箱地址，也就没有垃圾邮件面。若以后要邮箱别名，只做 Email **Routing** 收信转发、**不开** Email **Sending**（那是带 DKIM/DMARC/配额/信誉的新负担），且转发的目标邮箱只留在控制台 |

**本机已具备 / 尚缺的前置条件**（[实测] 2026-10-09 只读复探）

| 前置 | 状态 | 说明 |
| --- | --- | --- |
| `gh` 对 github.com 的 token scopes | ✅ 含 `workflow`（另有 `repo`、`read:org`、`gist`） | Phase 2 推 workflow 文件不会撞 `refusing to allow an OAuth App…`；缺就先 `gh auth refresh -h github.com -s workflow` |
| GitHub noreply 身份 | ✅ 已取得 | 数字 id **不写在这份文档里**，用时现取（它和账号名一起构成可反推的公开身份） |
| 推送传输方式 | ✅ 已定：HTTPS + gh 的凭据助手 | [实测] 2026-10-13 `git config --global` 里 github.com 与内网实例都配了 `credential.<host>.helper`（GitHub CLI）；`GIT_TERMINAL_PROMPT=0` 下 `git ls-remote` 走 https 不再索要用户名 ⇒ 不需要解锁 SSH key。上一版记的「协议是 ssh」说的是 gh 的 git-operations 配置，与 origin 实际走 https 是两回事 |
| Cloudflare 凭据（本机） | ❌ 本机仍无 | [实测] 本机没有 `wrangler`、没有可复用的 OAuth 会话、环境变量也没设。所有 Cloudflare 调用都是**临时目录里的 token 文件 + curl**，不落 shell 配置、不进仓库；CI 侧读 Actions secrets，与本行无关（见 §13） |
| 公共 npm registry | ✅ | 全机无 `.npmrc`，registry = `https://registry.npmjs.org/` |

最后一行是**检查过的**，不是假设：内部 npm 镜像地址如果写在全局 `.npmrc` 里，公开仓库的 CI
日志会把它带出来 —— 那是内网拓扑泄漏。本机既然没有全局 `.npmrc`，公开 CI 的 `npm ci` 这条路是干净的。

## 11. 公开推送前的 scrub 清单（Phase 2）

按**类别**扫，不按文件名：内部主机名与域名、邮箱地址、token/密钥形状、绝对路径、内部人名、
工单/issue 链接、任何只在内网可达的 URL。执行顺序：

1. `git checkout --orphan public`（**先孤立再公开**，历史一条都不带）
2. 单提交用 GitHub noreply 身份作者/提交者；本机 git identity 绝不出现在公开历史里
3. scrub `AGENTS.md` 里的内部 GitHub 主机名。**[实测] 只有这一处** —— 该主机名在工作树里只命中
   `AGENTS.md` 一行，`docs/agents/issue-tracker.md` **不含**它（那个文件是从 `git remote -v`
   现推出来的，所以公开仓库里既没值可泄、也不会推错东西）。本节先前写成"两处"是错的：
   清单里多一个不存在的目标，会让人以为扫完两个文件就安全，而真正的判据是**按类别扫全树**。
4. `node <skill>/scripts/audit-public-repo.mjs --history .` 必须干净
5. 推公开 remote（token scope 需含 `workflow`，否则报
   `refusing to allow an OAuth App to create or update workflow` → `gh auth refresh -h github.com -s workflow`）
6. **推送前把改动过的文档自己重读一遍**：凡是会随这次推送移动的计数或当前状态 —— 跑过几个 run、别名此刻
   服务哪一份、最近一次部署的 hash、某条结论重复验证过几次 —— 一律写成**带 commit 锚点的历史陈述**（到
   `<commit>` 为止……）或纯规则，不许留下没有截止点的「此刻 / 最后一次 / 下一个」。[实测] 本文在这一条上
   被自己咬过不止一次：点名别名 hash 的句子就当场变假过，`deploy` 的次数与「最后一次」也在下一次发布后
   变假。这不是「记得补记」能救的 —— 补记描述的永远是下一次推送**之前**的状态。

**[实测] 沙盘已经跑通一遍**（临时目录 clone → 删 `origin` → scrub `AGENTS.md` →
`git checkout --orphan` → 用 noreply 身份做**单个**提交 → 分支改名 `main` →
`audit-public-repo.mjs --history .`）：**findings 0 / exit 0 / 84 个跟踪文件**（那是当时的数字；2026-10-13 正式那一轮是 **85** 个，多出的是 `LICENSE`，见 §13 —— 跟踪数会变，所以每次推送前重跑，不拿「上次扫过」当依据）。
被消掉的那条是 `personal-email-in-commit-metadata`（MEDIUM）：本机 git identity 的私人邮箱在
**每一个提交的 author/committer 元数据**里 —— 它不在任何文件里，`--orphan` 之前删多少行都没用，
只有"不带历史 + 换身份"这一种修法。（审计行的 `+39 commits` 是**命中次数**，按 §13 查到的根因它是 2C-1
= 2×20-1 = 39，不是提交数，别把它读成"还有 39 个别的提交"。）

**[实测] 2026-10-13 沙盘复跑：findings 0 / exit 0**，但踩到一件 `--orphan` **不会**替你做的事：
分支改名成 `main` 之后，暂存仓里残留的 `refs/heads/master` 仍指向旧历史，而审计是**照着 ref 扫历史**的，
于是继续报那条 MEDIUM `personal-email-in-commit-metadata`。上一版把它读成"main 上还带着私人邮箱"是
**误判**，真相是自己的 ref 卫生问题。修法三步：删 `refs/heads/master` → `reflog expire --expire=now --all`
→ `gc --prune=now`，然后**重跑审计**才拿到 0（worktree 84 文件、history blobs 84、`commits_ALL=1`、
pack 108 个对象）。

**公开侧与内网侧的 `AGENTS.md` 从此有意分叉**：scrub 把"issue 跟踪在内网 GHES"那句改写为
`(this repository's GitHub Issues)`，公开那份指向公开 Issues，内网那份保持不变。分叉是**预期结果**，
不是漏改。危险的方向是反向同步：把公开侧的改写稿回灌内网，会让内网同事的 issue 链接指到不存在的地方。
合并方向只许**内网 → 公开**，而且每次都要重跑 scrub + 审计，不许拿"上次扫过"当依据。
**公开是不可逆的。** 后面删文件不会把它从历史里删掉，`git log -p -- <path>` 免费拿回来。

## 12. 同一个 workflow 在两个 remote 上的不同命运

[实测] 2026-10-09 对内网实例的只读探测（GHES 的仓库级 Actions API）：

| 探测项 | 端点 | 结果 |
| --- | --- | --- |
| Actions 有没有启用 | `…/actions/permissions` | `enabled: true`、`allowed_actions: all` |
| 这个实例上有几个 runner | `…/actions/runners` | **`total_count: 0`** |
| 仓库里已登记的 workflow | `…/actions/workflows` | `total_count: 0` |
| 未显式声明时的默认权限 | `…/actions/permissions/workflow` | `default_workflow_permissions: write` |
| 默认分支 | `…/<repo>` | `master` |

**探测本身的坑**：`…/repos/<repo>/actions` 在 GHES 上**不存在**（404）。把它当"Actions 没启用"
会得出与事实完全相反的结论 —— 真相在 `actions/permissions`。GHES 的 REST 路由和 github.com 有差异，
每个端点都要单独看返回，不能用一次 404 概括整块功能。
另：`actions/permissions/selected-actions` 在 `allowed_actions: all` 时返回 **409 Conflict**
（"All actions and workflows are allowed"），那也是"没限制"的意思，不是错误状态。

**后果**：这个 workflow 的触发器是裸 `on: push` + `on: pull_request`（**没有分支/路径过滤**）。
推到内网实例 ⇒ 任何分支每次 push 都建一个 run，而 `runners = 0` ⇒ 没有任何进程认领它。
它既不红也不绿：官方 limits 表（docs.github.com / Actions limits，Self-hosted 段）原文是
"A job can be in the queue for 24 hours before it is automatically cancelled." —— 排队最多
24 小时后被**自动取消**。用词是 **cancelled 而不是 failed**：CI 列表里留下的是一条"已取消"的记录。
（GHES 自己的 limits 页这次取不到，数字来自 cloud 版文档；"要等多久"会变，"没人认领"不会。）
叠加 §2 的 `concurrency.cancel-in-progress: true`，同一条 ref 上的下一次 push 会提前取消排队中的那一个。

⇒ 每次向内网实例 push 都产生一条**无人认领、最终被取消**的 run。这不是红灯，是噪音；
而噪音的真正代价是让将来的真红灯失去意义。

**第二个后果（决定要不要在 GHES 上跑）**：GHES 没有 GitHub 托管 runner，只能自架；而
`actions/upload-artifact@v4+` 在 GHES 上不受支持（§2）。所以就算以后接上 self-hosted runner，
这份 workflow 还得退回 v3 —— 等于同一套门禁维护两份真相。

**四条路（已选 O1，2026-10-13 实施）**：

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| **O1（已采用）** | 三个 job 各加 `if: github.repository == 'microsheen/python-code-map'` | 内网实例上整体 `skipped`（秒过、不产生僵尸 run），公开仓库门禁完整生效。原先写的前置条件「先定公开账号与仓库名」已于 2026-10-13 满足 |
| O2 | 照原样推 | 接受每次 push 一条排队到被取消的 run |
| O3 | workflow 只进公开仓库 | 要重排本地**尚未推送**的历史，内网那份从此没有 CI |
| O4 | 请管理员关掉内网实例的 Actions | 影响整个团队，不该由这次改动的作者代劳 |

**已实施（2026-10-13，O1）**：`checks` / `browser-smoke` / `deploy` 三个 job 各带一条 `github.repository`
判断，坐标放在 `env.PUBLISHED_REPO`，§2 的第 3 条断言守住「恰好 3 次」这件事。本地**验不到** skipped
的实际效果 —— 那条结论只能等 Actions 上第一次真跑出来，现在说"内网已经安静了"是没有依据的。

**O1 的 `if` 和 §3 的 `DEPLOY_ENABLED` 是两件事**，不要混用成一个开关：`DEPLOY_ENABLED` 回答
"要不要发布"，O1 的 `if` 回答"这条流水线归谁跑"。

顺带一条好消息：内网实例的默认 workflow 权限是 `write`，而本 workflow 显式写了
`permissions:` 块（§2），落下去的范围**比平台默认更窄**。这次显式声明是往**窄**了收，不是往开放了放。

**这一段已经执行完了（2026-10-13）。** 上一轮写的是"只 commit、未 push，留给用户点头"，当时确实
一个都没推（[实测] `git rev-list --count origin/master..HEAD` = 10）：理由是把一个已知会在
`runners = 0` 实例上产生噪音的 workflow 推上去，副作用落在别人的 CI 页面上。O1 守卫落地之后，
"产生噪音"这个理由不再成立，而 AGENTS.md 要求的"改动前先 pull 再 push"重新占上风，于是推了：
`fd40a45..341fe8d  master -> master`（11 个提交），推完 `origin/master..HEAD` = 0。结果见 §13。

## 13. Phase 2 实况：仓库已公开、站点已上线（`python-code-map.pages.dev`），域名已绑、待异网复测

**已做到**（以下均 [实测] 2026-10-13）：

- 公开仓 `microsheen/python-code-map` 已建：`has_issues: true`、`auto_init: false`，`default_branch` 已是
  `main`。建法是 `gh api -X POST /user/repos`，**先私有**，绿了再翻公开。[实测] 2026-10-13 **已翻公开**：
  `gh repo edit --visibility public --accept-visibility-change-consequences` 退出码 0，回读
  `visibility=PUBLIC`、`isPrivate=false`。翻完立刻做两件翻之前做不了的事：① **匿名克隆**
  `git -c credential.helper= clone`（`GIT_TERMINAL_PROMPT=0`）退出码 **0**、`HEAD=860e92d`、tracked=**85**、
  `commits_ALL=1` —— 这条路只有在仓库真的公开时才不会去要用户名，所以它本身就是「公开可读」的证明；
  ② 匿名 `raw.githubusercontent.com` 取 `README.md` = **200 / 19,941 B**。探针别选 `robots.txt`：
  它只存在于 `dist`，仓库根没有，匿名请求得到 404，那是**探针错**不是仓库不可读。
- 仓库变量 `DEPLOY_ENABLED` = `false` 已建。注意用 `POST`：`PUT /actions/variables/<name>` 是**更新**，
  变量不存在时返回 404，拿 PUT 当创建会误以为"已经设过了"。
- scrub 过的**单提交**已推到 `main`，远端只有 `refs/heads/main` 这一条 ref。
- 首次 Actions run（push 触发，14 秒）：`checks` 红在 `Install from lockfile`，根因与修法见 §2 第 4 条；
  `browser-smoke` 因 `needs` 级联 skipped —— **这是正常行为，不是第二个故障**；`deploy` skipped 的原因是
  `DEPLOY_ENABLED=false`，**不能**拿它当 O1 归属守卫生效的证据：skipped 的 job 不告诉你到底是哪一条
  条件为 false，两条开关的作用域要靠日志分开看。
- [实测] **O1 对 GHES 的效果已验证通过**（2026-10-13，紧接上面那次推送）：
  内网那条 push 只生成一条 run `4083631`（实例名与账号名按纪律不写在这里）
  （`event=push`、`headBranch=master`、`status=completed`、`conclusion=skipped`）；
  `gh run view 4083631 --json jobs` 里 `checks` / `browser-smoke` / `deploy` 三个 job 全部
  `conclusion=skipped` 且 `queued` 为假。所以"内网不再产生排队到被自动取消的僵尸 run"这句话现在有
  依据了。但这只证明**归属守卫**有效：`master` 本来也不是生产分支，两条条件同时为 false，
  这次 skipped 依然不能当作 `deploy` 可运行的证据。[实测] 到内网 `e87ab5d` 为止这条守卫已经重复验证**五次**：
  run `4083631`（`341fe8d8`）、`4084045`（`97e5e727`）、`4084065`（`628146eb`）、`4084267`（
  `ea7c3b8e`）、`4084948`（`e87ab5d8`），五次都是 `event=push`、`headBranch=master`、`status=completed`、
  `conclusion=skipped`，且 `gh run view --json jobs` 里三个 job 全部 `skipped`，没有一次例外。第五次
  的价值不在于把「能跑」证得更牢 —— 它证的还是同一件事 —— 而在于排掉「恰好那一次另有条件为 false」这种巧合。
  「五次」是**带截止点**写的（到内网 `e87ab5d` 为止）：此后每次推内网只会再添一条形状相同的 skipped，本文不再
  逐个补记 —— 和别名 hash 同一个道理，会一直变的东西写进文档就注定过期，要证的是「有没有例外」，不是「共几次」。

- [实测] **公开镜像重做并强推，到 `58775b7` 为止四轮**：`b31c700 → 0a3e0cf → 2224d10 → 860e92d → 58775b7`（远端每次都报
  `main -> main (forced update)`，`ls-remote` 每次只有 `refs/heads/main` 一条 ref）。单提交、tracked=**85**、
  `commits_ALL=1`。旧的 `b31c700` 不含 `LICENSE` 与这几天的实测改正，所以必须整轮重跑 scrub；第二、三轮的
  动机都是文档自己：旧版 §13 留着 32 位全哈希，而 32 位独立 hex 与 Cloudflare 的 account/zone id **同形**，
  会命中 `audit` 的 `opaque-32-hex-id`（改法与理由见 §4）。[实测] 第三轮把归因做到了 blob 级：两处命中来自
  `docs/ops-deployment.md` 的**旧 blob**，只在内网提交里可达，工作树文件里按同样的正则 `grep` **0 命中**；
  第四轮命中的**还是那个旧 blob** —— 这正说明「改好工作树」不会让旧 blob 消失，它只能靠 `scrub2.sh` 的删 ref
  + `gc --prune=now` 才离开仓库。[实测] 第四轮删完 ref：`refs` 只剩 `main`、`in-pack=109`、findings **0**、
  `AUDIT_EXIT=0`。轮数同样**带截止点**（到 `58775b7` 为止四轮）：此后每重做一遍就多一轮，本文不再补记 ——
  要留的是「每轮都得整轮重跑 scrub，旧 blob 只能靠删 ref + `gc --prune=now` 才走得掉」这条方法，不是计数器。
- [实测] **`git push` / `git ls-remote` 打 github.com 会静默挂死，不报错也不退出**：本机对 github.com 留着
  `http.https://github.com.proxy`（一个本机端口上的隧道）。隧道吊住时 TCP 连上了却永远等不到响应，而 git
  自己不带超时 ⇒ 命令就这么挂着，看上去和「网络断了」无法区分，实际远端一直是好的。诊断别用同一条会挂的
  命令：用 `Invoke-WebRequest -Proxy <同一地址> -TimeoutSec 15` 单独去问那个代理答不答。[实测] 同一条探测
  在这一天里既出现过无响应、也出现过 `200` ⇒ 它会自愈，所以这里只写判据、不写当前状态。处置：杀掉**自己
  刚起的那两个**进程（`git` 与 `git-remote-https`）再重推；**不改 git 配置、不绕代理** —— 这台机器的出网
  路径不归 agent 决定。预防（本节所有网络命令的统一跑法）：包在 `Start-Job` + `Wait-Job -Timeout 55` 里，
  超时就 `Stop-Job`；[实测] `Start-Job -FilePath` 只接受 `.ps1`，把 `git.exe` 直接交给它会当场报错。
- [实测] **`git pull --ff-only`（不带 remote/branch）会间歇性报 `fatal: Cannot fast-forward to
  multiple branches.` 并退出 128，而当时本地与远端本来就对齐**：2026-10-14 在内网 remote（GHES）上
  连踩两次，都在同一个状态里 —— `master` 与 `origin/master` 同为 `077d3d8`、工作树 clean、远端只有
  `refs/heads/master` 一条 head。所以报错点名的那个「多分支」**不存在**：这是工具假故障，不是远端多了
  分支、不是历史分叉要 rebase、也不是仓库坏了。判据（当场全部取到，都在 `077d3d8` 这个状态上）：
  ① `git ls-remote --heads origin` 只有一条；`git for-each-ref` 只有 `refs/heads/master` 与
  `refs/remotes/origin/{master,HEAD}`，`refs/prefetch` 为空；② 手工 `git merge --ff-only FETCH_HEAD`
  返回 `Already up to date.`、退出 0；③ 前后几分钟内三种替代写法各跑一次全过 —— `git pull`（不带
  `--ff-only`）、`git pull --ff-only origin master`、`git -c maintenance.auto=false pull --ff-only`；
  ④ `GIT_TRACE=1` 下失败那趟的链路是 `fetch --update-head-ok` → `maintenance run --auto --no-quiet
  --detach` → `merge --ff-only FETCH_HEAD`；⑤ 紧接着连跑三次裸 `git pull --ff-only`，三次全过 ⇒
  **自愈、非确定性**。次数因此按「到 `077d3d8` 为止」写死，此后每踩一次都只添一条同形记录，本文不补记。
  一处保留：`.git/FETCH_HEAD` 是**失败之后**才读的，只有一条 for-merge 记录，而 git 不保留失败瞬间的
  那一份 ⇒ 它只能算旁证，不能算「merge 当时看到几条」的直接证据。**推断（未证实）**：`maintenance run
  --detach` 派生的后台进程与紧随其后的 `merge --ff-only FETCH_HEAD` 争用同一个 `FETCH_HEAD`，merge
  读到多于一条 for-merge 记录，就按 `--ff-only` 的口径直接 die。这条推断带一个可推翻的预测：
  `-c maintenance.auto=false` 应当**永不**复现 —— 但它只跑通一次，而间歇故障本来也会自愈，n=1 立不住
  因果；同理，「不带 `--ff-only` 就免疫」也只有 n=1，**别**当成结论。所以在攒够样本之前不要照它去关
  maintenance。处置：重跑一次即可（[实测] 会过）；要一次避开就写全 `git pull --ff-only origin master`，
  或 `git fetch origin` + `git merge --ff-only origin/master`。**不改 git 配置、不动 `maintenance.*`**
  —— 与上一条同一纪律：出网与本机 git 行为不归 agent 调。真正的危险动作是拿这句报错当依据去
  `checkout` / `reset` / `rebase`：仓库本来是对齐的，这类操作只会把同步状态改坏（`AGENTS.md` 那条
  「不要自行 `git checkout` 恢复文件」同样管这里）。版本锚点：git 2.52.0.windows.1。
- [实测] **`drive-scrub6.sh` 停在 `scrub.sh` 末尾是预期行为，不是第二个故障**：那一步的 `audit --history` 在
  还没删掉 `refs/heads/master` 之前跑，必然报 MEDIUM，`set -e` 于是把后续脚本切掉。[实测] 从第二轮起**每一轮
  重跑报的都是同样 3 条 MEDIUM**：2× `opaque-32-hex-id` + 1× `personal-email-in-commit-metadata`，命中行全部
  落在仍可从 `refs/heads/master` 达到的内网提交里，**不是**新工作树的内容 —— 先确认命中的是哪个 ref，再决定
  是改文档还是删 ref，别一上来就动本来就没问题的正文。所以卡住时接着单独跑 `scrub2.sh`
  （删 ref → `reflog expire` → `gc --prune=now`）才会拿到 findings 0。上一版那句「ref 卫生问题」说的就是这里。
  [实测] 第五轮把那个计数查到了根上，不再是「记一笔现象」：`audit-public-repo.mjs` 收 commit 邮箱时按
  **字段**记账 —— 它对每个提交取 `%ae` 与 `%ce`，author 和 committer 各算一条 hit，报出来的后缀其实是
  `hits.length - 1`。设 C = 带着这个邮箱的提交数，那就等于 **2C-1**。三个历史数字对得严丝合缝：内网 32 个
  提交时报 `+63 commits`、33 个报 `+65 commits`、34 个报 `+67 commits` —— 每多 1 个提交，这个数多 2。
  所以**它压根不是提交数**，拿它去核对「有多少提交带着这个邮箱」一定错；要核对就直接
  `git rev-list --count master`（到 `e87ab5d` 为止 = **34**）。这条解释同时是一条**可推翻的预测**，已经兑现
  过一次：`4f63c15` 把内网提交数 C 推到 35，从它重建的 stage 报的正是 `+69 commits` = 2×35-1。此后每重跑一轮
  scrub 都多一次同样的核对，本文不逐个补记 —— 谁要复核，当场 `git rev-list --count master` 取 C，再看审计
  后缀是不是 2C-1。
- [实测] **审计对象是「远端干净克隆」，不是本地 stage**：翻公开之前用认证克隆审 `860e92d`，得到
  `worktreeFiles=85 / historyBlobs=85 / blocking=0 / findings=[]`、退出码 **0**；翻公开之后改用
  `git -c credential.helper= clone` 的**匿名**克隆，先审 `860e92d`、再审第四轮推上去的 `58775b7`，两次结论
  一致：`commits_ALL=1`、`refs` 只剩 `main`、tracked=**85**、findings **0**、退出码 **0**。匿名这条路本身就
  是「公开可读」的证明 —— 私有仓在 `GIT_TERMINAL_PROMPT=0` 下会直接失败在要用户名那一步 —— 但它**不**证明
  内容干净，内容干净靠 `audit`，两条各证一件事，都要留。对 `58775b7` 那份匿名克隆再按内网主机名、内网 owner、
  个人邮箱域、Windows 绝对路径前缀、token 前缀、IDE 名、本机用户名逐类 `git grep`：**9 类全部 0 命中**。
  审 stage 只证明「我打算推的东西干净」，审克隆才证明「已经推上去、CI 也将要构建的那一份干净」。
- [实测] **到 `58775b7` 那次推送为止 `deploy` 真跑过四次，两种触发方式都通了**：
  `38359980657`（`workflow_dispatch`，`0a3e0cf`）、
  `38364378715`（`push`，`2224d10`）、`38367105331`（`push`，`860e92d`）、`38381569045`（`push`，`58775b7`，
  `deploy` job `115243516823`），四次的 `checks` / `browser-smoke` / `deploy` 全部 `success`。push 触发才真正
  暴露 §3 那个开关的日常形态：`DEPLOY_ENABLED=true` 之后**任何人推 `main` 都立刻发布**，中间没有确认步骤。
  每一次都做一次互证：wrangler stdout 的「Take a peek over at …」与 Pages API 的 `latest_deployment.url`
  和 `id` 对得上。`58775b7` 那一次报的是 `https://cf9de4e2.python-code-map.pages.dev` /
  `cf9de4e2-7990-4586-a2b9-a0233f2dc611`；此后每推一次都多一条这样的地址，本文不逐个补记（写法依据见
  §11 第 6 条）。地址**只认 stdout**，API 只当旁证。
- [实测] **deploy 日志里那行红色的 `[ERROR] A request to the Cloudflare API (/accounts/*****/pages/projects)
  failed.` 不是故障**：那是 workflow 故意「先试建项目」的分支，返回 `code: 8000002`
  （`A project with this name already exists`），紧跟着一行「project 已存在，继续」，job 最终 `success`。
  把 ERROR 字样读成部署失败，就会去找一个不存在的故障；为了日志干净把它消掉，又会丢掉「项目名全局唯一、
  重跑不报错」这个设计依据。两种冲动都别顺。
- [实测] **生产别名每推一次 `main` 就换一个 host，只有不可变 URL 不动**：到 `58775b7` 为止的移动史是
  `36266ff7` → `91eaa8c6` → `d3a75dd9` → `cf9de4e2`。这条链是历史陈述，不会过期；「别名此刻服务哪一份」
  则一定过期，所以这里不再写它。上一版立的规则是「只记方法与当时那次的证据」，被自己撞破过一次（那句
  点名 `d3a75dd9` 的话当场成了假声明）；后来收紧成「最后一次记录具体 hash」，而这一句又会在下一次推送后
  立刻变假。结论写进 §11 第 6 条：会随推送移动的值**一律不写当前态**，要么写成带 commit 锚点的历史陈述，
  要么只留规则。不可变部署 URL 照记（它们不会动）。验证命令因此**只能用生产别名**，地址只取 wrangler
  stdout 的「✨ Deployment complete! Take a peek over at …」这一行，不许猜；Direct Upload 的主机形状是
  `<~8hex>.<project>.pages.dev`，**不存在** git-SHA 主机。
- [实测] **跨 run 的产物确定性要用字节证，不能用日志措辞证**：本轮参照系换成 `58775b7` 那次 run 的 `dist`，
  与 `860e92d` 那次取回的产物逐文件比 —— **26 / 26 个文件、文件名零差异、逐文件 sha256 零差异**，两份
  总量都是 **2,083,473 B**。线上另比一层：`91eaa8c6`、`d3a75dd9`、`cf9de4e2` 三个不可变 host 连
  生产别名共 **4 个 host × 5 条路径** —— `/`（914 B）、`/metadata.json`（49 B）、`/robots.txt`（
  209 B）、`/wasm/tree-sitter.wasm`（209,613 B）、`/_expo/static/js/web/entry-9069ffa5…js`（
  **1,392,408 B**）—— sha256 两两相同且全部 `vs --dist MATCH`，整轮 `CHECK_EXIT=0`；上一轮已用同样
  5 条路径把 `36266ff7` 与前两个 host 比齐，所以 `0a3e0cf`、`2224d10`、`860e92d`、`58775b7` 四个
  不同 commit 的四次独立构建在这 5 条路径上字节相同。覆盖面要说清，不然这句就是虚的：**逐文件全等只对
  那两份本地产物成立（2 个 commit）**，另两个 commit 只有 5 条抽样路径的证据，「四份产物 26 个文件全等」
  目前**没有**依据。两次比对的参照系不同（上一轮 `dist-run9`、这一轮 `dist-run11`），而这两份已被上面
  那句逐文件全等证到完全相同，所以 `MATCH` 与 `MATCH` 之间接得上。工具坑照旧：`gh run download` 必须
  显式 `-R <owner>/<repo>`，否则它按当前目录的 `origin` 解析 run id，而本机 `origin` 是内网那台实例
  ⇒ HTTP 404。反过来，wrangler 那句 `✨ Success! Uploaded 0 files (7 already uploaded)` **不能**
  当证据：`Uploading... (7/7)` 里的 7 与 `dist` 里实际的 **26** 个文件对不上，这个数字在数什么没搞清；
  语义不明的日志行只能记下来，不能拿去支撑断言。
- [实测] **三份 CI 产物两两全等，于是「别名服务哪一份」反而不能用字节证**：`860e92d`、`58775b7`、`daca42bb`
  三次 run 取回的 `dist`（`dist-run9` / `dist-run11` / `dist-run14`）互为参照，两两都是 **26 / 26 个文件、
  文件名零差异、逐文件 sha256 零差异**，三份总量都是 **2,083,473 B**。覆盖面要说清：这只把逐文件全等从
  2 个 commit 推到 **3 个**，「四个及以上全等」依旧**没有**依据 —— 本轮自己的产物要等推上去才取得回，
  不可能在这段里替它背书。由此得到一条推论：既然跨 run 逐字节全等，「生产别名此刻服务的是哪一份部署」
  **拿字节比对永远证不出来** —— 三份长得一模一样，比谁都是 `MATCH`。唯一权威是 Pages 项目的
  `canonical_deployment` 字段：[实测] 到 `daca42bb` 为止它等于 `latest_deployment` =
  `2a2133de-2f88-4e8d-80cf-c610addd1e9d`，带 commit 锚点（§11 第 6 条）所以不会随下一次推送变假。读法
  一次就够：`GET /accounts/<acct>/pages/projects/<project>`；[实测] 不带 project 段的
  `/pages/deployments/<id>` 返回 **404**，`/environments` 的 `result` 是**项目形状的对象**而不是数组，
  直接迭代会抛 `object is not iterable`。
- [实测] **上线验证 exit 0 clean**：`check-deploy.mjs --mode=browser --dist=<CI 产物>`，`/`、两个 wasm、
  `robots.txt` 跨 host 字节一致且与 CI 产物一致。平台差异两条照旧：`x-robots-tag: noindex` 只在
  `<hash>.<project>.pages.dev` 上有、生产别名没有，归入 server-dependent 不计入；`/index.html` 别放进
  `--paths` —— 本轮又实测了一遍，四条路径里其余全部 MATCH，只有它因为 308 的跳转体被判成 diff，
  `CHECK_EXIT=1`，是假的。这里的参照系始终是 `gh run download <id> -n dist` 取回的 **CI 产物**，
  不是本机重建（原因见下条）。
  [实测] 2026-10-13 这一层又补两条**只属于工具和平台**的发现。其一，大文件会被工具自己的短超时打死：
  `entry-9069ffa5…js`（**1,392,408 B**）在 3 host 与 4 host 两次运行里各有一个 host 报
  `FAILED This operation was aborted`，`CHECK_EXIT` 因此是 **1**；同一条路径改用 240 s 超时加重试单独
  重取，三个 host 全部 `200 1392408 B`、sha256 与产物相同，整趟十几秒 ⇒ **大文件先怀疑超时，别怀疑
  内容**。把「exit 0 clean」当模板抄，就会把一次工具故障读成站点故障。其二，自定义域名会拿到**平台注入**：
  `--mode=browser` 下 apex 的 `/` 是 **1,281 B**，其余三个 host 与 `dist` 都是 **914 B**，多出的 367 B
  是 Cloudflare Web Analytics 往 `</body>` 前插的一段 `<script type="module">`，src 指向
  `static.cloudflareinsights.com/beacon.min.js/v4…`，**只对浏览器形状的请求注入**（默认 UA 就看不到），
  `pages.dev` 上也没有 —— 这是 §6「平台会改写你发出去的东西」的一个新实例，也正是 `--mode=browser`
  这个开关存在的理由。按 `_headers` 里我们自己的 CSP（`script-src 'self' 'wasm-unsafe-eval'`）这段跨源
  脚本应当被浏览器拦掉，但本机真浏览器打 apex 只拿到中间设备的拦截页，**这条推断没能在浏览器里实测**。
  同一台机器的真浏览器打 `pages.dev` 是**跑起来的**：标题 `Python Code Map`、`#root` 有子节点、页面文本
  471 字符、控制台零条消息、`<script>` 只有我们自己的 entry —— 顺带证明 §5 那些头没在浏览器里把应用打死。
- [实测] **本机重建 ≠ CI 产物，而且与时间戳、与缓存都无关**：干净 `npm ci` + `npm run export` 得
  `entry-d2ba5fa1…js`（1,398,755 B），CI / 线上是
  `entry-9069ffa5…js`（1,392,408 B）；删掉 `%TEMP%\metro-cache`（1758 个文件）
  再加 `--clear` 重建，哈希**不变**。按行比对：`__d` 模块集合完全相同（827 个，零增删、零内容差异），
  差的是一行 **6,346 B 的预运行时片段**（内含 `formatValueCalls`、`_isPolyfilled`，即 RN 的 console
  polyfill 连 `pretty-format` 一起打进来），本机有、CI 没有 —— 也就是说差异在 **Metro 的 polyfill 段**，
  不在业务代码里。**根因未定位**，所以在此之前不许对外声称「从源码能复现出逐字节相同的线上产物」。
  站点的可信度不依赖这句话：CI 的冒烟与部署用的是**同一个 artifact**，tested==shipped 在流水线内部成立。
- [实测] **拦不拦自定义域名，取决于走哪条路，不取决于「这台机器」**：2026-10-13 上午同一时刻
  `*.pages.dev` 直连正常，而 `python-code-map.com` 与 `www.` 的 443 得到 13,850 / 14,935 B 的拦截页、
  80 端口得到 307 跳到一个网关主机，应答方 `server` 头是中间设备的产品名、**没有 `cf-ray`** ⇒ 不是
  Cloudflare 答的（产品名按纪律不写在这里），这正是 §8 那条「先问谁答的」。同一天稍后，同一台机器上出现
  相反的一面：`node` 直连（不经系统代理）带浏览器形状的请求头打 apex，拿到的是**真** Cloudflare 应答 ——
  五条路径全 `200`、`cf-cache-status` 与 `server-timing` 里 `cfEdge` `cfOrigin` 俱在，只有 `www.` 稳定
  `522`；而就在同一时刻，**真浏览器**（走系统代理那条路）打 apex 仍是一张「网站被拦」的错误页。⇒ 判据
  不是「办公网等于全拦」，而是每一次都看 `cf-ray` 在不在；结论要按**路径**写，按机器写就注定哪天被推翻。

**没做到的，不许写成已完成**（[实测] 2026-10-13）：

- **自定义域名还没在真浏览器里被端到端验证。** Cloudflare 侧的证据已经齐了：域名 `status=active`，DoH 查
  `python-code-map.com` 与 `www.` 各返回两条 Cloudflare anycast A 记录（apex 的 CNAME 被
  flattening 藏起来，查不到 CNAME 是正常结果）。[实测] 2026-10-13 `node` 直连这条路上 apex 已经拿到 CF
  真应答、逐路径与产物相等（`/` 多一段平台注入，见本节那条 Web Analytics），但本机真浏览器仍被中间设备
  挡住 ⇒ 「人打开它能不能用」在这一条路上还没有证据，`--resolve` 也绕不过（它按 SNI 过滤）。⇒ 必须换
  一个网络（手机热点）拿 §8 那条命令复测一次，`--hosts=` 换成下面这三条生产别名（其余参数照 §8，尤其
  别再列 `/index.html`）：`https://python-code-map.com`、`https://www.python-code-map.com`、
  `https://python-code-map.pages.dev`。[实测] `www.` 那条**必然**进 counted 桶 —— 任何 `≥400` 都算
  finding，它现在是 `522`；要么先按下面那条把它删掉，要么复测时把它单独归因，别当成部署坏了。
  **只用生产别名，不要把 `<hash>` 主机写进去** —— [实测] 它每推一次 `main` 就换一个新的不可变 host，
  把当时那一个写死进命令，下一次推送就失效；`--dist=` 也要配**同一次 run** 的产物，否则字节必然对不上。
  在那之前，「办公网里打不开 `python-code-map.com`」**不算**站点故障。
- **`www` 此刻不服务本应用，线上稳定实测 `522`；「两个 origin、两份 IndexedDB」还没发生。**
  [实测] 2026-10-13 连取三次 `https://www.python-code-map.com/` 全是 `522` + 7,293 B 的 Cloudflare
  错误页，同一分钟内 `python-code-map.com` 与 `python-code-map.pages.dev` 全是 `200` + 914 B；三个应答
  都带 `server: cloudflare` 和 `cf-ray` ⇒ 答的是 Cloudflare 自己，不是 §8 那台中间设备（它的应答没有
  `cf-ray`），也不是「部署坏了」（同一份部署的另两个 host 全好）。成因在配置面：[实测] Pages 项目
  `domains` 只有 `python-code-map.pages.dev` 与 `python-code-map.com` 两条，而 zone 里是两条 CNAME
  （`@` 与 `www`，都 `proxied: true`）⇒ `www` 只是一条 DNS 记录，**从没作为 custom domain 挂进项目**，
  CF 于是按「有记录、没绑应用」去回源。上一版这一条照着 DNS 记录和 DoH 结果写成两个 hostname 都在服务，
  比证据强，已按实测改掉。**双 origin 什么时候变成真**：有人只把 `www` 挂进 Pages 项目而不配 301。
  三条处置按省事程度重排 —— ① 删掉 zone 里 `www` 那条 CNAME 回到单 origin：token 有 Zone DNS 权限，
  而且**行为零变化**，因为它本来就不服务；② 真要让 `www` 可用，得「挂 Pages custom domain」和
  「建 `www.*/(.*)` → apex 的 301 Redirect Rule」两步**一起做**，后者 agent 建不了（[实测] 2026-10-13
  Zone Rules 四个只读接口全 403，细节见 §7），只能人来；③ 什么都不做，但对外只给
  `python-code-map.com` 与 `python-code-map.pages.dev`，不给 `www.` 前缀。风险形状从「数据分裂」变成
  「输 `www.` 的人看到一张 CF 错误页」，仍然该在推广入口地址之前定下来。
- **翻公开带来的 Actions 审批面还没收。** `pull_request` 这条触发现在对全网 fork 打开：陌生人提 PR 就会
  排队消耗 Actions 分钟。[实测] 2026-10-13 `actions/permissions` 返回 `allowed_actions=all`、
  `actions/permissions/workflow` 返回 `default_workflow_permissions=read`、`can_approve_pull_request_reviews=false`；
  secrets 对 fork 触发的 `pull_request` 默认不下发，所以这条路的真实风险是**算力与日志噪音**，不是凭据泄漏。
  `Settings -> Actions -> Require approval for all outside collaborators` 只能人在页面上勾（API 够不着），
  而且要等一次真实 fork PR 被拦下来才算验证生效 —— 现在还没有过一次外部 PR。
- **对外推广入口地址这件事仍然不该现在做。** 三条前置没齐：自定义域名没在**另一张网络的真浏览器**里验过、
  `www` 的去留没定（它现在拿到的是 CF 的 `522`，见上）、Actions 的外部 PR 审批面没收。在此之前只给
  `python-code-map.pages.dev` 是安全的 —— [实测] 2026-10-13 本机真浏览器打开它**应用是跑起来的**：标题、
  `#root` 的子节点、控制台零条消息都对得上。给 `python-code-map.com` 就要先假定「收件人不在办公网里」，
  否则对方打开的是中间设备的拦截页。
- `vars.DEPLOY_ENABLED` 的**回退路径**没实测过：现在它是 `true`，也就是说此后每一次推 `main`
  都会真的发布。真要止住，把它设回 `false` 并**确认 run 里 `deploy` 变 skipped**，才算验证过 §3。