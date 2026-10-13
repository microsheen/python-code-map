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
   - 仍然存在的边界：`vars.DEPLOY_ENABLED == 'false'` 使 `deploy` 仍 skipped。skipped 的 job 不回答
     "是哪一条条件为 false"，所以它既不能当 O1 的证据，也不能当 `deploy` 跑得通的证据。O1 已于
     2026-10-13 用另一次推送单独验证（§13）；而 `deploy` 里 wrangler 的鉴权、以及 `actions: write`
     覆盖的 download-artifact 路径**至今没有真实执行过**，第一次真跑仍可能红。
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
  建 DNS 记录需要 token 有 **Zone / DNS: Read + Edit**，否则 `10000 Authentication error`；
  改 token 权限**不会**换 token 字符串，所以 CI 里那个 secret 不用重新粘贴。
  HTTPS 在 Pages 翻到 `active` **之前**就能用：泛域名证书在 zone 接管域名的那一刻就覆盖了它，
  `active` 只表示 Pages 接受了归属。
- **`www` 与 apex 是不同 origin ⇒ 不同 IndexedDB 命名空间。** 对本应用意味着同一份会话被劈成两份，
  这是**数据完整性**问题不是美观问题。修法是一条 Redirect Rule：`www.*/(.*)` → apex，301
  （需要 Zone Rules 权限，没有就 403）。
- 保留 `pages.dev` 作为对照与回滚锚点。担心重复内容收录就在**那个 host 上**加
  `X-Robots-Tag: noindex`，而不是把它重定向走。本仓库 `robots.txt` 当前是 `Allow: /` —— 纯客户端工具被索引不会暴露任何用户内容；
  不想要检索就把那两行换成 `Disallow: /`（注意它同样只是**声明**，见 §5 的 TTL 覆写）。
- 默认**没有 HSTS**，已在 `_headers` 里自己加。

## 8. 上线后验证（观测点决定结论）

```bash
node <skill>/scripts/check-deploy.mjs \
  --hosts=https://<apex>,https://www.<apex>,https://<project>.pages.dev \
  --paths=/,/index.html,/wasm/tree-sitter.wasm,/robots.txt \
  --dist=dist --mode=browser
```

退出码：`0` 没有 counted finding，`1` 至少一个，`2` 用法错。counted 桶包括：跨 host 字节不一致、
HTML 里出现第三方引用、服务端字节与 `--dist` 不一致、counted 头不一致、**状态码跨 host 不一致**、
**任何 ≥400 的响应**（会连 `server` 头一起打）、传输错误。`--ignore-header` 只用于**已经判定为
平台差异**的头 —— 它同时会把后面几次真正由你主机应答的运行也消音。

**[实测] `pages.dev` 与自定义域名是不同的故障域。** 在某企业工作站上，同一分钟内 `*.pages.dev`
返回 `200 + server: cloudflare`，而 apex 和 `www` 返回固定 ~15 KB 的拦截页，或 307 到一个
不是你的主机名。不涉及 DNS、证书、部署 —— 是**验证机上面的中间设备**替 Cloudflare 应答了。
比较内容之前先问"谁答的"；先修观测点，再判断字节。

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

## 10. 尚未拍板的项目（阻塞 Phase 2 的公开推送）

| 项 | 状态 |
| --- | --- |
| 现有代码库内容对外公开的合规性 | ✅ 2026-10-13 用户明确「允许」 |
| 公开目标账号与仓库名 | ✅ `microsheen/python-code-map`（[实测] 此前在 github.com 上 404，即不存在同名仓库） |
| 公开仓库默认分支 | ✅ `main`（用户未指定，采用建议默认值；workflow 两处同步见 §2 第 2 条） |
| GHES 那份 workflow（O1–O4） | ✅ 选 O1，已实施，并于 2026-10-13 **实测通过**：推内网后 run 整体 `skipped`、不排队，见 §13 |
| LICENSE | ✅ 选 MIT（2026-10-13，agent 代拍 —— 仓库此刻仍是 private，翻公开前你一句话就能换成 Apache-2.0 或撤掉）。`LICENSE` 文件已真实存在（1067 字节，LF），不是只在 README 里声称 |
| `package.json` 的 `license` / `repository.url` / `author` | ✅ 已随许可证在同一次提交里补齐：`license: MIT`、`author: microsheen`、`repository.url` 指向公开仓。真正的许可 bug 是"manifest 声称 MIT 但没有 `LICENSE` 文件"，所以两者必须一起落 |
| Cloudflare API token 与 account id | ✅ 2026-10-13 用户直接提供。只存在仓库之外的临时目录，并已写入 Actions secrets（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）；**任何一份拷贝都不进仓库、历史、文档** |
| 域名：复用已有 zone 还是新注册 | ✅ `python-code-map.com` 的 zone 已在该账户下且 `status=active`；[实测] 区内 DNS 记录 0 条，是干净的。绑定要 API 加域名 + 手动建 `@` 与 `www` 两条 proxied CNAME（API 不会替你建 CNAME） |
| Pages 项目名 | 待拍板。名字**全局唯一且不可改名**，它同时出现在 `<project>.pages.dev`、CI 的 `vars.PAGES_PROJECT_NAME` 和域名 CNAME 的目标里；最直白的候选很可能已被陌生人占用，要一次定下带备选的方案 |
| 反馈渠道 | ✅ 定为只用 GitHub Issues（2026-10-13，agent 代拍）：仓库已开 `has_issues`，零新增配置、不在页面上公开任何邮箱地址，也就没有垃圾邮件面。若以后要邮箱别名，只做 Email **Routing** 收信转发、**不开** Email **Sending**（那是带 DKIM/DMARC/配额/信誉的新负担），且转发的目标邮箱只留在控制台 |

**本机已具备 / 尚缺的前置条件**（[实测] 2026-10-09 只读复探）

| 前置 | 状态 | 说明 |
| --- | --- | --- |
| `gh` 对 github.com 的 token scopes | ✅ 含 `workflow`（另有 `repo`、`read:org`、`gist`） | Phase 2 推 workflow 文件不会撞 `refusing to allow an OAuth App…`；缺就先 `gh auth refresh -h github.com -s workflow` |
| GitHub noreply 身份 | ✅ 已取得 | 数字 id **不写在这份文档里**，用时现取（它和账号名一起构成可反推的公开身份） |
| 推送传输方式 | ✅ 已定：HTTPS + gh 的凭据助手 | [实测] 2026-10-13 `git config --global` 里 github.com 与内网实例都配了 `credential.<host>.helper`（GitHub CLI）；`GIT_TERMINAL_PROMPT=0` 下 `git ls-remote` 走 https 不再索要用户名 ⇒ 不需要解锁 SSH key。上一版记的「协议是 ssh」说的是 gh 的 git-operations 配置，与 origin 实际走 https 是两回事 |
| Cloudflare 凭据 | ❌ 无 | 环境变量 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 都不存在；`wrangler` 不在 PATH；`%APPDATA%\xdg.config\.wrangler` 下**没有 `config/`** ⇒ 没有可复用的 OAuth 会话 |
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

**[实测] 沙盘已经跑通一遍**（临时目录 clone → 删 `origin` → scrub `AGENTS.md` →
`git checkout --orphan` → 用 noreply 身份做**单个**提交 → 分支改名 `main` →
`audit-public-repo.mjs --history .`）：**findings 0 / exit 0 / 84 个跟踪文件**。
被消掉的那条是 `personal-email-in-commit-metadata`（MEDIUM）：本机 git identity 的私人邮箱在
**每一个提交的 author/committer 元数据**里 —— 它不在任何文件里，`--orphan` 之前删多少行都没用，
只有"不带历史 + 换身份"这一种修法。（审计行的 `+39 commits` 是**命中次数** = 20 个提交 × 2，
不是提交数，别把它读成"还有 39 个别的提交"。）

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

## 13. Phase 2 实况：公开仓已建（仍 private）、首跑红、内网那次验证已补上

**已做到**（以下均 [实测] 2026-10-13）：

- 公开仓 `microsheen/python-code-map` 已建：`private: true`、`has_issues: true`、`auto_init: false`，
  `default_branch` 已是 `main`。建法是 `gh api -X POST /user/repos`，**先私有**，绿了再翻公开。
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
  这次 skipped 依然不能当作 `deploy` 可运行的证据。

**没做到的，不许写成已完成**：

- 站点仍未上线。已到位的是 secrets（token + account id）和 zone；还缺 `vars.PAGES_PROJECT_NAME` —— 项目
  名全局唯一且不可改名，这一项必须人拍板。定了之后 `deploy` 才是**第一次真实执行**：wrangler 鉴权、
  `project create` 的两条分支（首次创建 / 已存在继续）、以及从 stdout 解析不可变 URL
  （"✨ Deployment complete! …"那一行），只跑一次，URL 只取日志、不许猜。
- `Settings -> Actions -> Require approval for all outside collaborators` 仍要人在页面上勾（API 够不着）。
- 可见性还没翻。既定顺序：CI 全绿 → 翻 public → **从干净克隆再审计一次** → 再谈域名与 Pages 项目名。