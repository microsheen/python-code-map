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
| 现有代码库（公司内部 GitHub 实例）内容对外公开的合规性 | 待确认 |
| 公开目标账号与仓库名 | 待确认 |
| LICENSE | 待拍板（许可是选择，不是继承） |
| `package.json` 的 `license` / `repository.url` / `author` | 待随许可证一起补 |
| Cloudflare API token 与 account id 的提供方式 | 待确认（本机无环境变量；wrangler 未安装） |
| 域名：复用已有 zone 还是新注册 | 待确认 |
| Pages 项目名（**全局唯一、不可改名**） | 待确认 |
| 反馈别名与回复身份 | 待确认 |

## 11. 公开推送前的 scrub 清单（Phase 2）

按**类别**扫，不按文件名：内部主机名与域名、邮箱地址、token/密钥形状、绝对路径、内部人名、
工单/issue 链接、任何只在内网可达的 URL。执行顺序：

1. `git checkout --orphan public`（**先孤立再公开**，历史一条都不带）
2. 单提交用 GitHub noreply 身份作者/提交者；本机 git identity 绝不出现在公开历史里
3. 清掉 `AGENTS.md` 与 `docs/agents/issue-tracker.md` 里的内部 GitHub 域名
4. `node <skill>/scripts/audit-public-repo.mjs --history .` 必须干净
5. 推公开 remote（token scope 需含 `workflow`，否则报
   `refusing to allow an OAuth App to create or update workflow` → `gh auth refresh -h github.com -s workflow`）

**公开是不可逆的。** 后面删文件不会把它从历史里删掉，`git log -p -- <path>` 免费拿回来。