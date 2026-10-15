~~~
当刷新网页的时候，应该能记住当前的文件选择，而不会完全回到初始页面。
~~~

## 2026-10-09 发布路线 B（公开仓库 + 自定义域名 + CI 门禁）

- 门禁复跑：typecheck / lint（0 error、12 warning 为既有）/ jest 15 suites 225 tests 全绿。
- `npm run export` 复测（09:39 +08:00）：入口 `entry-d2ba5f….js`；
  `dist/index.html` 1182B -> 914B（剥掉 3 段 HTML 注释）；sha256
  `52eb64f4935e49d71077056fe7426a78c1d08385499fe119ec93dea595c6d071`；产物内绝对 URL 0 个。
- `npm run smoke` 复测（09:40 +08:00）：39/39 PASS、退出码 0。真实请求集 5 个，全同源、全 GET、
  零请求体、无 4xx；生产 CSP（`default-src 'none'`，只放开 `wasm-unsafe-eval`）下零违规。
- 本轮新增/改动：`public/_headers`、`public/robots.txt`、`scripts/polish-dist.mjs`、
  `scripts/browser-verify.mjs`（加 S1-S3 / E1-E8 承诺面断言与 `_headers` 本地回放）、
  `.github/workflows/ci-and-deploy.yml`。
- 文档纠偏：README 与 ADR-0001 原文都写着「不落任何持久化存储」，与实际行为
  （IndexedDB 保存全量文件内容）矛盾 —— 错的声明比持久化本身危害大。README 改为
  「纯前端零上行」+「会话只存在你自己的机器上」两条，ADR-0001 追加 Amendment（2026-10）。
- wrangler 版本核对：4.148.0 / 4.149.0 均存在于 registry；CI 固定 `wrangler@4.149.0`，
  其 engines 要求 node >= 22，与 setup-node 的 22 一致。
- 完整运维记录与被实测到的平台坑：`docs/ops-deployment.md`。
- 待拍板（阻塞公开推送）：对外公开合规性 / 目标账号与仓库名 / LICENSE /
  Cloudflare 凭据提供方式 / 域名 / Pages 项目名（全局唯一且不可改名）/ 反馈别名。
## 2026-10-13 复验与运维文档补记（CI 权限缺陷已修；公开推送仍待拍板）

- 修复 CI 权限作用域缺陷：GitHub 文档明确「一旦显式声明 permissions，未列出的 scope 一律降为
  `none`」；补上 `actions: write`（workflow 内 4 处 artifact 读写需要），并把生产分支名的两处
  硬编码做成 Git Bash 断言 —— 实测三种情形：一致则绿、只改一处则红（exit 1）、两处同改则绿。
- `docs/ops-deployment.md` 由 222 行补至 349 行：新增 §12（GHES Actions 探测结果与端点陷阱），
  并更正上一轮两处写错的结论 —— 内部主机名在工作树中只出现于 `AGENTS.md` 一处（不在
  `docs/agents/issue-tracker.md`）；审计输出的 `+39` 是命中次数而非提交数。
- GHES 只读复探：本仓库 `actions/runners` 的 total_count = 0，而 Actions 已启用。推论：任何新的
  workflow run 只会排队，最长 24 小时后被**自动取消**（官方 limits 用词为 cancelled，非 failed）。
  因此本轮的 5 个提交刻意停在本地，等公开仓坐标与 `if: github.repository == '<owner>/<repo>'`
  守卫一并定案后再推，避免在内网留下成批僵尸 run。
- 复验：`npm run verify` 第三次独立运行，225 个用例全过；`dist/index.html` 的 sha256 与基线
  逐字节一致（构建可复现）；仓库审计仍只有 1 条 MEDIUM（commit 邮箱元数据），须在公开推送前
  用 scrub + `--orphan` 流程清除，沙盘已验证该流程可得到 0 findings。
- 待用户拍板（阻塞后续）：对外公开合规性 / 公开仓坐标 / LICENSE / Cloudflare 凭据提供方式 /
  域名 / Pages 项目名（全局唯一且不可改名）/ 反馈渠道形态 / GHES 守卫方案 / 推送传输方式。
## 2026-10-13 Phase 2 启动：O1 守卫落地，路线 B 又解锁三项

- B1 合规：用户明确「允许」把本代码库对外公开。
- B2 公开仓坐标：`microsheen/python-code-map`（实测 github.com 上此前返回 404，即不存在同名仓库）；
  默认分支用户未指定，采用建议默认值 `main` —— `env.PRODUCTION_BRANCH` 与 `deploy` 的 `if` 两处同步
  改完，复跑断言 `n=1`、`'master'` 残留 0 次。
- B8 GHES 那份 workflow：选 O1。三个 job（checks / browser-smoke / deploy）各加一条
  `if: github.repository == '<公开仓坐标>'`，并新增第二条断言要求该字符串**恰好出现 3 次**
  （少抄一处不会红灯，只会让内网重新排僵尸 run）。查证：workflow 级 `if` 不是 workflow-syntax
  记录在案的顶层键（该页锚点里查不到 `if`），所以不能写成一处生效。
- B9 推送传输：origin 实际是 https；github.com 与内网实例都配了 gh 的 credential helper，
  `GIT_TERMINAL_PROMPT=0` 下 `git ls-remote` 不再索要用户名 ⇒ 不需要解锁 SSH key。gh 对 github.com
  的 token 含 `repo` + `workflow`，够建公开仓并推 workflow 文件。
- 本地复验：`js-yaml` 解析 workflow 通过（顶层键 6 个、三个 job 的 `if`/`needs`/steps 数都符合预期）；
  Git Bash 实跑两条断言 guard=3 / ref_name_main=1 / ref_name_master=0。
- 文档：`docs/ops-deployment.md` 349 → 364 行（§2 新增第 3 条机器规则、§10 状态表更新、§12 实施记录）。
- 仍待拍板：LICENSE / Cloudflare 凭据提供方式 / 域名 / Pages 项目名 / 反馈渠道形态。

## 2026-10-13 Phase 2 落地：公开仓已建（仍 private）、CI 首跑红在 npm 大版本、workflow 一次自我破坏

- 公开仓 `microsheen/python-code-map` 已建（private / has_issues / auto_init=false，default_branch=main），
  仓库变量 `DEPLOY_ENABLED=false` 用 `POST /actions/variables` 建好（PUT 是更新，无变量时 404）。
  scrub 后的单提交已推到 `main`。
- 首跑 run：`checks` 红在第 4 步 `Install from lockfile`。根因不在代码里，在 **npm 大版本**：本机锁文件
  由 npm 11 生成，npm 10 跑 `npm ci` 判定不同步（实测 `npx npm@10 ci --dry-run` exit 1，报 Missing
  `@emnapi/core` / `@emnapi/runtime` / `react-native-worklets@0.10.4`；npm 11.6.2 则 up to date）。
  修法：CI 两处 `node-version` 22 → 24，并加 `Toolchain matches the lockfile generator` 断言 npm 主版本。
  这条本地 5 次 verify 全绿也照不出来 —— 只有 Actions 真跑才暴露。
- 自我破坏一次并已修：改 workflow 时先记下 `node-version` 的行下标、再在上方插入 15 行，下标全部失效，
  把 `node-version: '24'` 写进了 browser-smoke，**覆盖掉** `- name: Upload evidence`，导致该 step 出现两个
  `if` 键、js-yaml 报 duplicated mapping key。教训：改动一律按**内容锚点**定位，多行插入必须自底向上。
- 本地验收：js-yaml 解析通过（3 个 job 的 if/needs/steps 逐个核对）；断言 guard=3 / ref_name_main=1 /
  ref_name_master=0；`node-version` `'22'` 计数 0、`'24'` 计数 2；`npm run verify` exit 0（15 suites / 225 passed）。
- 沙盘 scrub 复跑 = findings 0。上一版那条 MEDIUM 来自改名后**残留的 `refs/heads/master`**，不是 main；
  删 ref + `reflog expire` + `gc --prune=now` 后重跑才归零。scrub 会改写公开侧 `AGENTS.md` 的 issue 那句，
  两侧文档从此有意分叉，合并方向只许内网 → 公开。
- 更正一条过期声明：§2 里 `actions: write` 的 403 预测原先写"[推断，非实测]"，现在首跑确实跑了，但**没走到**
  artifact 步骤，所以那条预测仍未被证实或证伪 —— 措辞已改。
- 仍未做：10 个提交没推内网 ⇒ O1 的实际效果没有依据；可见性没翻；站点没上线。
  仍待拍板：LICENSE / Cloudflare 凭据提供方式 / 域名 / Pages 项目名 / 反馈渠道形态。

## 2026-10-13 更正：CI 红的真实根因是 npm 小版本，不是大版本；锁文件已补齐

上一条（"CI 首跑红在 npm 大版本"）里的根因判断**是错的**，本轮用Actions日志把它推翻并改正。
保留原文不删，是因为"我如何得出一个错误定论"本身就是这条流水线的风险清单。

- **决定性证据**：第二次 CI run `38353547848` 的 `Toolchain` step 打印 `node=v24.21.0 npm=11.19.0
  lockfileVersion=3`，而本机是 node 24.12.0 / npm 11.6.2。本机跑 `npx npm@11.19.0 ci --dry-run`
  （Windows，不加任何 `--os/--cpu`）**完整复现** CI 的 `Missing: @emnapi/core@1.11.3 /
  @emnapi/runtime@1.11.3`；同一份锁在 11.6.2 下 exit 0。所以是**小版本**差异，与 OS 无关 ——
  先前四轮 `--os/--cpu` 复刻方向全错，"这条本地验不出来"也随之作废。
- **机制**：`@napi-rs/wasm-runtime` 的 `peerDependencies` 要 `@emnapi/core|runtime`，它挂在
  `cpu=wasm32` 可选子树里；锁中只有 `@unrs/resolver-binding-wasm32-wasi/node_modules/@emnapi/*`
  这份 1.10.0 嵌套副本，**没有顶层条目**。npm 11.19.0 要求补齐 → `npm ci` 判锁不完整。
- **修法**：`npx npm@11.19.0 install --package-lock-only` 重新生成锁。diff = **仅新增**
  `node_modules/@emnapi/{core,runtime}@1.11.3` 两条（`optional`+`dev`），1135→1137，
  无删除 / 无版本变动 / 无 `resolved` 变动。
- **[实测] 复发条件**：本机 npm 11.6.2 再跑一次 `install --package-lock-only` 就把两条**剪回 1135**，
  锁又装不动。所以 workflow 的断言从"npm 主版本=11"升级为**完整版本 11.19.0**，不符先
  `npm install -g npm@11.19.0` 再复核；step 改名为 `Toolchain pins the npm that generated the lockfile`。
- **[实测] 补齐后的核对**：`npm ci`（11.19.0 真装，含 root postinstall copy-wasm）exit 0 /
  `added 1096 packages`；`npm run verify` 15 suites / 225 passed / exit 0；`npm run export` 产物
  **26 个文件的哈希集合与路径集合与修复前完全一致**（先比过一次发现差异，差异是我把基线里
  `forward.png` 的路径抄错了目录，改正后重比 = 相同）；换 11.6.2 与 11.19.0 两棵树各导出一次，
  产物仍相同 → tested==shipped 成立，"产物不变"是比出来的不是推出来的。
- **workflow 结构复核**：`js-yaml` 解析通过，`checks` 10 steps / `browser-smoke` 6 / `deploy` 5，
  守卫字符串 3 次、`ref_name_main=1`、`ref_name_master=0`、`ASSERT_OK`。
- 同步改正 `docs/ops-deployment.md` §2 第 4 条（整段重写，含两次错误结论的来龙去脉），文档 414→431 行。
- **仍未发生的事**：`deploy` 这次依旧是 `DEPLOY_ENABLED=false` 跳过，**O1 归属守卫的首次真实验证
  还没做**；仓库仍是 private；站点仍未上线。

## 2026-10-13 O1 实测通过：内网那 11 个提交推上去了，CI 不再产生僵尸 run

- **本轮把两件欠着的事一次做完**：按 AGENTS.md 的"改动前先 pull 再 push"推内网，并借此完成 O1
  归属守卫的第一次真实验证。上一轮之所以没推，理由是"会在 `runners = 0` 的实例上产生噪音"；O1 落地
  之后这个理由不再成立。
- **[实测] 推送**：`git fetch origin` 后落后 0（pull 是 no-op），`git push origin master` 得到
  `fd40a45..341fe8d  master -> master`（11 个提交），推完 `git rev-list --count origin/master..HEAD` = 0。
- **[实测] O1 生效**：那条 push 只生成一条 run `4083631` —— `event=push`、`headBranch=master`、
  `status=completed`、`conclusion=skipped`；`gh run view 4083631 --json jobs` 里 `checks` /
  `browser-smoke` / `deploy` 三个 job 全部 `conclusion=skipped` 且 `queued` 为假。
  "内网不会再产生排队 24 小时后被自动取消的僵尸 run"这句话从推断变成了依据。
- **但这不等于 `deploy` 能跑通**：`master` 既不是生产分支、`DEPLOY_ENABLED` 又是 `false`，两条条件
  同时为 false，而 skipped 的 job 不回答是哪一条挡住的。wrangler 鉴权和 `actions: write` 覆盖的
  download-artifact 路径**至今 0 次真实执行**。
- **[实测] B④ 落位**：CF token 与 account id 只存在仓库外的临时目录；`git ls-files` 与本轮 pending
  diff 按 token 前缀与 account id 两种形状扫，均 0 命中；两者已写入 Actions secrets，`gh secret list` 两条都在。
- **[实测] B⑤ 不用等 NS**：`python-code-map.com` 的 zone 已在该账户下且 `status=active`，区内 DNS
  记录 0 条。token 有没有"建记录"的权限**还没探**（探它要真写记录）；若缺权限，报错是
  `10000 Authentication error`，而在控制台补权限**不会改变 token 字符串**，CI 里那份 secret 不用重贴。
- **[实测] 对上一轮的包数差补了账**：CI `added 1098` vs 本机 `added 1096` = 同一份锁在两个平台上的
  可选原生二进制之差。`npx npm@11.19.0 ci --dry-run --os=linux --cpu=x64` 直接给出
  `added 4 / removed 2`：增 `lightningcss-linux-x64-{gnu,musl}` 与
  `@unrs/resolver-binding-linux-x64-{gnu,musl}`，删对应的两个 `*-win32-x64-msvc`。都在构建期，不进
  `dist/`，与浏览器产物无关。教训写进文档："两边数字不同"既不默认良性，也不默认有问题，先取证。
- **一次自己制造的泄漏，已当场改正**：写 §13 证据时把内网账号名（owner/repo）抄进了
  `docs/ops-deployment.md`，而这份文件是要进公开镜像的。`git grep -I` 复扫后把它改成
  "实例名与账号名按纪律不写在这里"；复扫结果只剩 `AGENTS.md` 里那条本来就要被 scrub 替换的主机名。
  纪律不是我"记得住"的东西，是每次 commit 前必须跑一遍的 grep。
- **仍待人拍板的三项**：LICENSE（许可是选择不是继承；选了就必须真有 `LICENSE` 文件，并同步补
  `package.json` 的 `license` / `repository.url`）；Pages 项目名（全局唯一、不可改名，CI 读
  `vars.PAGES_PROJECT_NAME`，没设就 `::error::` 主动红，不会静默发到别的项目）；反馈渠道（Email
  Routing 只做收信转发，转发的目标邮箱绝不进仓库/历史/文档）。
- **文档**：`docs/ops-deployment.md` 431 → 446 行。§2 第 4 条补"deploy 从未真跑"与包数取证；§10
  把 O1 / CF / 域名三行改成实测结论、新增"Pages 项目名""反馈渠道"两行、并删掉因此重复的两行；
  §12 那段"留给用户点头"改成已执行；§13 标题从"欠内网的那次验证"改成"已补上"，O1 证据从
  "没做到的"移到"已做到"。
## 2026-10-13 站点真的上线了：deploy 首跑三 job 全绿；域名已绑，但本机出口验证不了

- **Pages 项目已创建**：`python-code-map`、`production_branch=main`。[实测] `POST /accounts/<acct>/pages/projects`
  直接成功 ⇒ 这个名字全局未被占用，之前担心的"改名方案"不需要了。项目名不可改名，换名的代价写进了 §10。
- **[实测] `deploy` 第一次真实执行 = run `38359980657`**：`checks` / `browser-smoke` / `deploy` 三个 job 全绿。
  wrangler 4.149.0 鉴权通过、`download-artifact` 在 `actions: write` 下取回产物，上一轮那条"0 次真实执行"的
  边界已作废。`project create` 这次走"已存在"分支（`8000002`），"首次创建"分支由同一天本机直连 API 建项目时
  覆盖 —— 两条分支各真跑过一次。发布 URL 只从 stdout 取：`https://36266ff7.python-code-map.pages.dev`。
- **[实测] 上线验证 exit 0 clean**，但参照系换成了 CI 产物：`gh run download <id> -n dist` 取回的那 26 个文件
  才是权威。`/`、两个 wasm、`robots.txt` 在部署 host 与生产别名上字节一致且等于 CI 产物。
- **本机重建 ≠ CI 产物，且与时间戳、缓存无关**：干净 `npm ci` + `npm run export` 的 entry 是 1,398,755 B，
  CI / 线上是 1,392,408 B；删掉 metro 缓存（1758 个文件）再 `--clear` 重建，哈希不变。按行比对：`__d` 模块
  集合完全相同（827 个，零增删），差的是一行 6,346 B 的 RN console polyfill 段。**根因未定位**，所以不对外
  声称"从源码能复现逐字节相同的线上产物"；tested==shipped 只在流水线内部成立（冒烟与部署同一 artifact）。
- **[实测] 自定义域名绑好了但本机验不了**：`python-code-map.com` 与 `www.` 两条 proxied CNAME 已建（记录 0→2，
  顺带证实 token 有 Zone / DNS: Edit），Pages 侧域名 `status=active`。可这台机器 443 拿到的是中间设备的拦截页、
  80 端口 307 跳到网关，`--resolve` 按 SNI 过滤绕不过；同一时刻 `*.pages.dev` 正常。⇒ 结论只在 Cloudflare 侧，
  端到端必须换网络复测。公开文档里不写该设备的厂商产品名，只写判别方法（看有没有 `cf-ray`）。
- **公开镜像重做并强推**：`b31c700 → 0a3e0cf`，单提交、tracked 85、`audit --history` findings 0、远端只有 `refs/heads/main`。
- **[实测] 修掉一个门禁自身的 bug**：`leak-scan` 的白名单 key 用 `line.split(':')[0]` 取到的是文件名而不是行号，
  于是那条本来要放行的内网主机名永不匹配。改成按 `host|文件|` 前缀过滤 + 断言恰好 1 处命中 + 断言其余形状恒 0。
  门禁报"没扫到"和"扫到了"都可能是假的，只有断言了数量的扫描才算扫过。
- **两次自己制造的坑，记下来当纪律**：① 文档自检的 `mustDisappear` 会被我刚写进去的那句旧说法引用命中 ——
  过期断言得带上下文成整句，短到不可复用；② 用 `replace()` 打补丁时字符串不匹配就静默不替换，这一轮 §8 的
  引用改了一次没生效、靠复扫才发现。替换必须断言命中数恰为 1，和上面那条是同一个道理。
- **出口是透明 MITM 时不要关校验**：`fetch` 报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，取证发现签发方是网关的
  根 CA。把那张根 CA 导出成 pem、用 `NODE_EXTRA_CA_CERTS` 只给这一个进程，站点立刻 200。关掉 TLS 校验换来的
  "绿灯"证明不了任何事。
- **`DEPLOY_ENABLED` 现在是 `true`**：此后每推一次 `main` 都会真的发布。它的回退路径没实测过，写在 §13 未办项里。
- **文档**：`docs/ops-deployment.md` 446 → 498 行。§2 那条"从未真跑"的边界换成实测结论；§8 的示例命令删掉
  `/index.html`（[实测] Pages 对它返回 308，脚本取响应时用 `redirect: manual`，跳转体必然被判成与 dist 不一致 ——
  一个假阳性）并把"故障域不同"那条补成今天的实测数字；§10 从"待拍板"改成拍板台账；§13 增 8 条已做到、改 5 条未办。
## 2026-10-13 push→deploy 端到端跑通：生产 URL 移到 91eaa8c6；Zone Rules 实测 403，www→apex 只能人来

- **push→deploy 第一次真的走通**：run `38364378715`（`event=push`、`main` / `2224d10`），`checks` /
  `browser-smoke` / `deploy` 三个 job 全部 `success`。生产别名随之从 `36266ff7` 移到
  `91eaa8c6`（[实测] Pages API `latest_deployment.id = 91eaa8c6-f619-4946-af8c-01fd98af641a`）。
  `DEPLOY_ENABLED=true` 的实际含义这一次是**被验证过的**而不是被告知的：推 `main` 即发布，中间没有确认。
- **[实测] 跨 run 的产物确定性改用字节证**：`36266ff7`、`91eaa8c6`、`python-code-map.pages.dev` 三个 host
  一起比，`/`（914 B）、`/_expo/static/js/web/entry-9069ffa5…js`（1,392,408 B）、`/wasm/tree-sitter.wasm`
  （209,613 B）、`/metadata.json`（49 B）sha256 两两相同且全部等于 `38364378715` 的 CI 产物，`CHECK_EXIT=0`。
- **差点把一条看不懂的日志写成证据**：wrangler 报 `✨ Success! Uploaded 0 files (7 already uploaded)`，
  而 `Uploading... (7/7)` 里的 7 和 `dist` 实际的 **26** 个文件对不上。这个数字到底在数什么没搞清，
  所以它只能记成"未解释的观察"，不能支撑"CI 构建可复现"这类断言 —— 结论改由上面那条字节比较来支撑。
- **[实测] `www → apex` 这件事 agent 做不了**：`GET /zones/<zone>/rulesets/phases/{http_request_redirect,
  http_request_static_redirects,entrypoint}/entrypoint` 和 `GET /zones/<zone>/rulesets` **四条只读接口全部
  403 `10000 Authentication error`**，同一个 token 打 Pages、Zone DNS、Zone 详情都是 200 ⇒ 缺的是
  **Zone / Rules** 权限，不是"规则还没建"。三条路都得人来：控制台建规则 / 给 token 补权限（不换 token 字符串，
  CI secret 不用重贴）/ 删 `www` 记录回到单 origin。
- **`/index.html` 的假阳性又复现一次**：把它放进 `--paths` 后其余三条全 MATCH，只有它因 308 跳转体被判 diff，
  `CHECK_EXIT=1`。§8 的示例命令当初删掉它是对的，这次是反向验证。
- **审计对象换成远端**：从 github.com `git clone` 再跑 `audit --history`，`refs/heads/main = 2224d10`、
  `commits_ALL=1`、tracked 85、findings 0。审 stage 只证明"打算推的干净"，审克隆才证明"已经推上去的干净"。
- **本轮自己写坏又改回来的两处**（都属于"补丁应用成功 ≠ 文本正确"）：① 引用写成"见本节末那条"，
  实际那段在 §4；② 用"替换区间"插入新 bullet 时，原来跟在镜像那条后面的缩进续行被划到了新 bullet 下面，
  归属漂移，另外还多出 1 个空格。修法是拆成独立 bullet + 按段落边界复读一遍，而不信"脚本没报错"。
- **纪律**：门禁没红不等于扫描有效。本轮 `leak-scan2.mjs` 与 `npm run verify` 仍需在改完文档后重跑一遍才算数。
## 2026-10-13 翻公开：唯一不可逆动作落地，匿名克隆复审计 0 findings；确定性改用 4 host × 5 path 字节证

- 路线 B 的最后一道闸门是可见性。B① 用户的「允许」就是授权来源，B② 定的 `microsheen/python-code-map`
  就是公开身份，这一步不需要再造条件：`gh repo edit --visibility public
  --accept-visibility-change-consequences` 退出码 0，回读 `visibility=PUBLIC`、`isPrivate=false`。
- 翻完用两条**翻之前做不到**的独立证据复验：① `git -c credential.helper= clone` 配
  `GIT_TERMINAL_PROMPT=0` 匿名克隆成功，`HEAD=860e92d`、tracked 85、`commits_ALL=1`、`refs` 只剩 `main`；
  ② 匿名取 `raw.githubusercontent.com` 上的 `README.md` = 200 / 19,941 B。中途拿 `robots.txt` 当探针
  得到 404，那是**探针选错**（它只在 `dist` 里，仓库根没有），不是仓库不可读 —— 这种假阴性不记下来，
  下一轮就会有人把它当故障再查一遍。
- 匿名克隆那份再跑 `audit-public-repo.mjs --history`：`worktreeFiles=85 / historyBlobs=85 /
  blocking=0 / findings=[]`、退出码 0；对同一份克隆按内网主机名、内网 owner、个人邮箱域、Windows
  绝对路径前缀、token 前缀逐条 `git grep`，**全部 0 命中**。翻公开之前那次认证克隆的审计同样是
  findings 0 —— 两条各自证明一件事：前者证明「世界看到的就是这一份」，后者证明「这一份内容干净」。
- 翻公开带来的新面：`pull_request` 触发对全网 fork 打开。[实测] `actions/permissions` 是
  `allowed_actions=all`，`actions/permissions/workflow` 是 `default_workflow_permissions=read`、
  `can_approve_pull_request_reviews=false`；secrets 对 fork 触发的 `pull_request` 默认不下发，所以
  这里的真实风险是**算力与日志噪音**，不是凭据泄漏。「Require approval for all outside collaborators」
  仍是人在页面上勾的活（API 够不着），没勾之前不对外推广入口地址。
- 第三次部署 run `38367105331`（`push` / `860e92d`，`deploy` job `115195285027`）三 job 全绿；
  wrangler stdout 给 `https://d3a75dd9.python-code-map.pages.dev`，Pages API 的
  `latest_deployment.id` = `d3a75dd9-d5e9-4dba-a1ae-81d90eba85d1` 与它互证。生产别名已连着移动过
  `36266ff7 → 91eaa8c6 → d3a75dd9`，于是定一条停止规则：**不再为每次推送补 hash**，验证命令只用生产别名。
- 确定性改用字节证：三次 run 的产物中可比的两份都是 **26 个文件 / 2,083,473 B**；3 个不可变 host 连
  生产别名共 **4 host × 5 path**，sha256 两两相同且全部 `vs --dist MATCH`，`CHECK_EXIT=0`。上一版把
  wrangler 那句「Uploaded 0 files (7 already uploaded)」当旁证是**错的**，已撤回 —— `7` 和 `dist` 里
  实际的 **26** 个文件对不上，语义不明的日志行不能支撑断言。
- 文档侧：`docs/ops-deployment.md` 524 → **553** 行，§10 加「仓库可见性」一行、§13 改写 12 处；
  `mustDisappear` 14 条要求「当前恰好命中 1 且不被新文本写回」，其中「两次的」差点被自己新写的
  「前两次的」命中，是断言拦下来的，不是人眼看出来的。
## 2026-10-13 发布路线 B（第四轮镜像上线；确定性升到逐文件；别名停止规则收紧）

- 翻公开之后又走完一整轮：文档 round-2 落盘 → 内网提交 `e87ab5d` → 重做 scrub → 公开仓 `main` 强推到
  `58775b7`（单提交、tracked 85、`commits_ALL=1`）。[实测] 对 `58775b7` 的**匿名**克隆复审计：
  `audit --history` findings 0 / 退出码 0，9 类目标逐类 `git grep` 全部 0 命中；匿名 `ls-remote` exit 0 与
  `raw.githubusercontent.com` 取 README = 200 / 19,941 B 各证一次公开可读（探针别选 `robots.txt`，仓库根没有它）。
- [实测] 第四次发布 run `38381569045`（push / `58775b7`，`deploy` job `115243516823`）三 job 全绿，
  wrangler stdout 给 `https://cf9de4e2.python-code-map.pages.dev`，与 Pages API `latest_deployment.id` 互证。
  日志里那句红色 `[ERROR] … (/accounts/*****/pages/projects)` + `code: 8000002` 是「先试建项目」的预期分支，
  紧跟「project 已存在，继续」：读成故障就会去找一个不存在的故障，为日志干净消掉它又会丢掉设计依据。
- 确定性证据升级并划清覆盖面：两份 CI 产物（`860e92d` 与 `58775b7`）**26 / 26 文件、文件名零差异、逐文件
  sha256 零差异**，总量都是 **2,083,473 B**；线上 **4 host × 5 path**（`91eaa8c6`/`d3a75dd9`/`cf9de4e2`/生产别名）
  sha256 两两相同、全部 `vs --dist MATCH`、整轮 `CHECK_EXIT=0`。上一版那句「三个不同 commit 产出同一份字节」
  实际只有 5 条抽样路径的证据撑着，被写成了全量 —— 本轮按覆盖面重写：四个 commit 在这 5 条路径上相等，
  逐文件全等只对那两个本地产物成立，「四份产物 26 个文件全等」目前**没有**依据。
- O1 归属守卫累计**五次** skipped：`4083631`/`4084045`/`4084065`/`4084267`/`4084948`，全部 `event=push`、
  `headBranch=master`、`completed/skipped`，且 `--json jobs` 三个 job 全 `skipped`。第五次的价值是排掉
  「恰好那一次另有条件为 false」这种巧合，仍然不能当作 `deploy` 可运行的证据。
- §13 的别名停止规则收紧成「**最后一次记录具体 hash**」：上一版刚立「不再为每次推送补 hash」，这一轮就又推了
  `main`，那句点名 `d3a75dd9` 的话当场成为假声明。此后 §13 不再写「别名此刻服务哪一份」，只记不可变 URL 与方法；
  验证命令一律用生产别名，`<hash>` 主机不进命令。
- 文档侧：`docs/ops-deployment.md` 553 → **571** 行，§13 一次改 8 处；`build-spec-r11.cjs` 的 `mustDisappear`
  12 条继续要求「当前恰好命中 1 且不被新文本写回」，`forbidden` 从 4 条加到 10 条（token 前缀、内网主机名与
  owner、个人邮箱域、account id、绝对路径前缀、本机用户名等），并额外对**整份当前正文**断言 0 命中。
- 翻公开带来的新面进了「没做到的」：`pull_request` 触发对全网 fork 打开，[实测] `allowed_actions=all`、
  `default_workflow_permissions=read`、`can_approve_pull_request_reviews=false`；secrets 对 fork PR 不下发，
  所以真实风险是算力与日志噪音。「Require approval for all outside collaborators」仍是人在页面上勾的活。
## 2026-10-13 发布路线 B（计数口径查到根因：audit 报的 +N commits 其实是 2C-1）

- 读 `audit-public-repo.mjs` 的 commit 邮箱段（取 `%ae` 与 `%ce`，后缀取 `hits.length - 1`）把上一节那个
  「多 1 个提交却涨 2」的现象查到根上：author 与 committer 各算一条 hit，报出来的数其实是 **2C-1**
  （C = 带着该邮箱的提交数）。三组历史数字全部对上：内网 32 个提交报 `+63 commits`、33 报 `+65`、34 报
  `+67`；`git rev-list --count master` 本轮实测 = **34**。结论写进 §13：这个后缀**不是提交数**，别拿它
  核对提交；同时留一条可推翻的预测 —— 下一个内网提交把 C 变成 35 时这里该报 `+69 commits`。
- 两条「计数」统一改成**带截止点**写法：O1 的「五次 skipped」标注到内网 `e87ab5d` 为止，镜像重做的「四轮」
  标注到 `58775b7` 为止。上一节刚立的别名规则本轮就被自己撞了一次（推 `main` 之后那句点名 `d3a75dd9` 当场
  成假声明），所以这里不再让文档背一个会一直变的计数器：要证的是「有没有例外」与方法，不是「共几次」。
- 门禁确实拦下一次：`build-spec-r12.cjs` 的 `mustAppear` 要求 `+67 commits` 这个字面出现在新文本里，而 frag
  当时只写了 `+67`，直接报错、补全后才通过 —— 数字与单位分开写就会失去可核对性，这条断言把它钉住了。
- 文档 571 → **579** 行（§13 三处：计数根因、O1 截止点、镜像轮数截止点）；`forbidden` 仍为 10 条并对整份
  正文断言 0 命中，`mustDisappear` 要求旧句「公开镜像重做并强推，四轮」不得被新文本回写，所以新句写成
  「到 `58775b7` 为止四轮」。
## 2026-10-13 发布路线 B（计数句一律带截止点：先改写法，再推第五轮镜像）

- 本轮要解决的矛盾：公开仓停在 `58775b7`，带的是文档 r10 版，里面「别名此刻服务 `d3a75dd9`」「`deploy`
  真跑过三次」这些句子已经在内部被改正 —— 对外留着假声明不对，所以必须再推一版修正。但按当时的 579 行
  正文直接推，第五轮一落地就当场把三句话变成**新的**假声明（`deploy` 多一次、别名多一个 host）。于是决定
  先改写法再推，而不是推完再补记 —— 补记描述的永远是下一次推送之前的状态，追不上。
- §11 scrub 清单新增**第 6 步**（元规则）：推送前重读改动过的文档，凡是会随这次推送移动的计数或当前状态
  （跑过几个 run、别名此刻服务哪一份、最近一次部署的 hash、某条结论验证过几次）一律写成**带 commit 锚点的
  历史陈述**或纯规则，不许留下没有截止点的「此刻 / 最后一次 / 下一个」。
- §13 三处按这条改写：`deploy` 的次数改成「到 `58775b7` 那次推送为止四次」（四个 run id 原样保留）；
  「最后一次是 `https://cf9de4e2…`」改成「`58775b7` 那一次报的是 …」并补一句此后每推一次多一条、本文不
  逐个补记；别名那条**删掉**「写这句话时 `python-code-map.pages.dev` 服务的是 `cf9de4e2`」整句，只留到
  `58775b7` 为止的移动史 `36266ff7 → 91eaa8c6 → d3a75dd9 → cf9de4e2`，并把规则写成通用式。
- 顺手改掉一处本文自己的算术错误：§11 沙盘那条原来写 `+39 commits` = 「20 个提交 × 2」，按 §13 查到的
  根因其实是 2C-1 = 2×20-1 = 39。旧句「（本轮 = **34**）」「下一个内网提交把 C 变成 35 时」也一并改成
  commit 锚定的完成时：到 `e87ab5d` 为止 C=34，`4f63c15` 把 C 推到 35 后从它重建的 stage 报的正是
  `+69 commits` = 2×35-1，预测兑现一次；此后每重跑都多一次同样核对，不再写「下一个」。
- 工具坑（新）：`mustDisappear` 是按**子串**判的，新句里若原样包含被禁子串（例：把「**`deploy` 真跑过四次」
  整句留在改后文本里）会报「被新文本写回」，所以断言要取到足够的左边界；含中文与 emoji 的 frag 用 PS
  单引号 here-string + `-Encoding utf8` 落盘后，仍要在 build 里断言无 `?`、`✨` 仍在，才算编码没被吃掉。
- 文档 579 → **588** 行；门禁：`doccheck` 无连续空行/无 CR/末尾无换行，`longLines>140` 仍是 12 条且全是
  既有的表格行，没有新增超长行（frag 里最长 111）。
## 2026-10-13 发布路线 B（www 此刻不服务：线上按 hostname 逐个实测，推翻「双 origin」）

- 本轮推翻的是上一版的一句强声明：§7/§13 曾照 DNS 记录（`@` 与 `www` 两条 CNAME）和 DoH 结果写「两个
  hostname 都在服务、同一份会话被劈成两份」。[实测] 2026-10-13 连取三次 `https://www.python-code-map.com/`
  全是 `522` + 7,293 B 的 Cloudflare 错误页，同一分钟内 apex 与 `pages.dev` 全是 `200` + 914 B，三个应答都带
  `server: cloudflare` 与 `cf-ray` ⇒ 答的是 CF 自己，不是中间设备、也不是部署坏了。成因在配置面：Pages 项目
  `domains` 只有两条，`www` 从没作为 custom domain 挂进去。于是 §13 那条重写为「此刻不服务，双 origin 是
  **潜在**风险」，三条处置按省事程度重排（删 CNAME＝行为零变化 / 挂域名＋301 两步一起做 / 什么都不做但对外
  不给 `www.`），§7 那句也跟着改成条件句并指向 §13。
- [实测] **出口按路径分，不按机器分**：同一天同一台机器，`node` 直连（不经系统代理）带浏览器形状的头能拿到
  CF 真应答，而**真浏览器**（走系统代理）打 apex 仍是拦截页。上一版「这台机器任何出口都被接管」是过度断言，
  已改成判据「每一次都看 `cf-ray` 在不在」；因此自定义域名剩下的缺口精确成「还没在另一张网络的**真浏览器**里
  端到端验过」，异网复测清单里也注明 `www` 那条**必然**进 counted 桶（任何 `≥400` 都算 finding）。
- [实测] **平台注入**：`--mode=browser` 下 apex 的 `/` 是 1,281 B，其余三个 host 与 `dist` 都是 914 B，多的
  367 B 是 Cloudflare Web Analytics 往 `</body>` 前插的 `<script type="module">`（默认 UA 看不到、`pages.dev`
  上没有）。这是 §6「平台会改写你发出去的东西」的新实例；按 `_headers` 里我们自己的 CSP 它应当被浏览器拦掉，
  但本机真浏览器进不到 apex，**这条推断没实测**，文档就照推断标注。同一台真浏览器打 `pages.dev` 应用是跑起来
  的（标题、`#root` 子节点、控制台零条消息），顺带证明 §5 那些头没在浏览器里把应用打死。
- [实测] **两条只属于工具的假信号**：其一，1,392,408 B 的入口 JS 在 3 host 与 4 host 两次运行里各有一个 host
  报 `FAILED This operation was aborted`（`--timeout` 默认 15000），改 240 s + 重试后三 host 全 `200` 且 sha
  相同 ⇒ 大文件先怀疑超时，别把工具故障写成站点故障。其二，`git push` / `git ls-remote` 打 github.com 会
  **静默挂死**：本机留着指向本机端口的 `http.https://github.com.proxy` 隧道，隧道吊住时 TCP 连上但永无响应，
  git 自己不带超时。判据是用 `Invoke-WebRequest -Proxy <同一地址> -TimeoutSec 15` 单独问那个代理，处置是杀掉
  自己刚起的 `git` 与 `git-remote-https` 再重推，**不改配置、不绕代理**；预防是统一包在 `Start-Job` +
  `Wait-Job -Timeout 55` 里（[实测] `Start-Job -FilePath` 只吃 `.ps1`）。
- [实测] **确定性证据从 2 个 commit 推到 3 个**：`860e92d` / `58775b7` / `daca42bb` 三次 run 取回的 `dist`
  两两 26/26 文件、零名差、零 sha 差、总量都是 2,083,473 B；**「四个及以上全等」依旧没有依据**，本轮自己的
  产物要等推上去才取得回。由此得到一条推论：跨 run 逐字节全等 ⇒「别名此刻服务哪一份」拿字节比对**永远**证不
  出来，唯一权威是 Pages 项目的 `canonical_deployment`。CF API 两个坑一并记下：不带 project 段的
  `/pages/deployments/<id>` 返回 404，`/environments` 的 `result` 是**项目形状的对象**而不是数组。
- 工具坑（新）：`node -e` 里的模板字符串会被 PowerShell 吞掉，一律改走单引号 here-string +
  `Set-Content -Encoding utf8` 落盘再 `node <文件>`；PowerShell 7.6.5 的 `-Encoding utf8` **无 BOM**（已按字节
  验过），所以这条路径是安全的。
- 文档 588 → **645** 行（§7 一处 DNS/522 同码不同因 + 一处把 `www` 的 origin 风险改成条件句、§13 七处）；
  门禁：`doccheck` 无连续空行、无 CR、末尾无换行，`longLines>140` 仍是 12 条且全是既有表格行。
## 2026-10-14 站点图标轮（v4 定稿：旧骨架、抽象风、简背景）

- 需求转了四圈：① 给 Python Code Map 设计图标并接进站点；② 反馈「太黑了、太复杂，简单抽象一点」；
  ③ 贴来一笔靛蓝 S 形参考图「像这样简单就好」，于是出了 v3（浅纸面 + 一笔双钩 S）；④ 看到 v3 用户澄清参考图
  **只是简单程度的例子**，要的还是原来那个图标 —— 风格更抽象、背景更简单 —— 于是 v4 定稿：保留旧版「四色节点 +
  连线」的代码图骨架，节点改实心圆角方块（蓝/黄/绿/紫 = 主题 accent/selected/ok 与 FILE_COLORS 的紫），连线改三条
  主题强调色圆头粗笔画，背景改纯色浅纸面；v2 的点阵网格、渐变底板、选中光晕、外框描边、箭头、节点内代码线全部去掉。
- v4 的几何不靠记忆：v2 的派生 SVG 还在 temp 目录（`codemap-icons-*/icon-192.svg`），节点坐标、连线走向、配色
  都从那里读回再化简。教训：未入库的重要产物要么早入库、要么留母版副本，否则「回退/参考」只能靠 temp 考古。
- 链路定成四段：`public/icon.svg` 唯一真源 -> `npm run icons`（真 Chrome 栅格化 favicon.ico 16/32/48 PNG-in-ICO +
  180/192/512 PNG，全部入库）-> `npm run export` 的 postexport 先跑 `scripts/inject-html-head.mjs` 把 4 个 `<link>` +
  2 个 `<meta>` 写进 `<head>`（幂等哨兵 `data-codemap="icon"`）再跑 `polish-dist.mjs`；本轮顺带修了注入的缩进 bug
  （按 `</head>` 所在行的缩进对齐注入块，不再破坏 polish 的字节基线）。
- 不变量与门禁：图标配色 ⊆ `src/theme.ts` 且必含 accentDim 与 paper（新增 `__tests__/icons.test.ts` 锁死，含 ICO 三档
  payload、PNG 角透明中心不透明、`_headers` 档位回放）；`npm run verify` 16 suites / 253 tests 全绿；`npm run smoke`
  41/41（新增 F 组：四个注入 href 真在 `<head>` 里 + 逐个能当 `<img>` 解码 —— headless Chrome 不抓 `<link rel="icon">`，
  没有这组图标就是真 CSP 下的盲区）；请求集 9 个，全同源、全 GET、零请求体、零 4xx。
- 基线（截止本次提交）：`index.html` sha256 `05acbf08114b0e3cfeaf5d2eecffce1836a24b12c886473a33cf136c31955f0a`（1455B）、
  入口 `entry-dd0b2e36….js`；v4 派生物字节数 favicon.ico 3005B / apple-touch-icon.png 5500B / icon-192.png 5680B /
  icon-512.png 16197B。v3 -> v4 只换图标字节，注入内容与 theme.ts 未动，故两个 sha 不动 —— 这本身就是
  「注入只写固定 href、与图标字节无关」的证据。
- `_headers` 给无 hash 的图标加一档：五个路径逐个列死 `max-age=0, must-revalidate`，**不**写 `/*.png` 通配 ——
  Cloudflare 的 `*` 跨路径分隔符，会连带命中 `/_expo/…/*.hash.png` 把 immutable 顶掉（同名头以最后命中规则为准）；
  该档理由与回放断言分别记在 ops §5 与 icons.test.ts。
- 文档同轮同步：README 新增「站点图标」节与命令表 `npm run icons` 行（形状描述在本轮改为 v4 的四色节点图）；ops 新增
  「[实测] 2026-10-14 图标轮基线」块、§5 图标档表格行、§8 给 check-deploy `--paths` 加 `/icon.svg` 与 `/favicon.ico`，
  并在基线块尾补同日再改版的历史注记。

## 2026-10-14 第六轮发布（图标 v4 上线；线上逐字节 == CI 产物；www 已被 301 收掉）

- 发布链路：内网 `513e25e` → 公开镜像单提交 `43c5d89`（强推 `+ 9ad753e...43c5d89`）→ run `38586197676`
  （run_number 13）`completed / success`，`checks` / `browser-smoke`（**41 / 41**，console 与 page exception 均 0）/
  `deploy` 三 job 全绿；wrangler 报 `Uploaded 7 files (5 already uploaded)`，不可变 URL 从 stdout 那行解析得
  `https://8b5659f6.python-code-map.pages.dev`（没猜）。第五轮 `9ad753e` 当时没入册，它的不可变 host 已无从考据，
  文档里按「没记下来」写，不补猜。
- 出口这条路本轮换了两次：仓库里那条 `http.https://github.com.proxy=http://127.0.0.1:9000` 的本地隧道**已经死了**
  （连接挂住不返回），改用用户授权的 `web-proxy…:8080`，而且**只用 `-c` 逐命令覆盖**、不动全局
  git 配置。顺带查到 `%TEMP%\codemap-secrets\cf.token` 那个 Cloudflare token **已失效**（直连与经代理都是
  `10000 Authentication error`）⇒ 本轮没法从 CF 侧读 `canonical_deployment`，「别名服务哪一份」这次只有
  wrangler stdout 与三 host 字节一致这两条证据。
- **本轮最硬的一条证据**：把 CI 产物（`gh api …/artifacts/11905721746/zip`，zip 579,788 B、展开 31 个文件）与
  线上三个 host 逐条比 —— `/` 三处都是 1,455 B、sha256 `9d6a1461…`，与产物 `index.html` 同哈希；`/` 引用的
  `entry-6f4f4584…js` 三处都是 `200` / 1,392,424 B、与产物同哈希；另外 8 条路径（两个 wasm、`robots.txt`、
  5 个图标）逐个 `200` 且同哈希。5 个图标因此**确认上线**：`icon.svg` 900 B、`favicon.ico` 3,005 B、
  `icon-192.png` 5,680 B、`icon-512.png` 16,197 B、`apple-touch-icon.png` 5,500 B，线上 / 本机 / 产物三方一致。
- 工具坑两条，都记进 ops §13：① 本机打 `*.pages.dev` 全 `000`，`-v` 出来是 Schannel 的
  `CRYPT_E_REVOCATION_OFFLINE (0x80092013)` —— **证书吊销服务器连不上**；DNS 正常、换公司代理也一样 `000`，
  加 `--ssl-no-revoke` 立刻 `200`。同一分钟 apex 不加也能通，所以这不是「一直都要加」。② `node` / undici 直连
  间歇性 `UND_ERR_CONNECT_TIMEOUT` / `aborted`，本轮打中 8 个 host × path，换 `curl --retry` 全过 ⇒
  **传输层报错必须重试之后才算 finding**。
- 一条会误导人的对照被定位了：`check-deploy --dist=dist` 拿**本机**产物去比线上，`/` 永远报 `DIFFERS`。本机 entry
  `dd0b2e36`（1,398,771 B）vs CI `6f4f4584`（1,392,424 B），差 **6,347 B**，与 ops 里上次量到的 Metro polyfill 段
  **6,346 B** 对得上（差 1 B 是段内长度字段随 bundle 变长）⇒ 老结论「本机重建 ≠ CI 产物」第二次复现，根因仍未定位。
  所以 `--dist=` 只能指 CI 产物；本机 `dist` 与 CI 产物 31 个文件里 **29 个同哈希**，差的就是 `index.html` 与 entry。
- 两条**已写进文档的现状被本轮实测推翻**，都按「带日期锚点的一次观测」改写而不是删掉：① `www` 从稳定 `522` 变成
  **`301` 跳 apex 且保留原路径**（三次取样，`cf-ray` 分别落 PDX / LAX / ATL；四个路径含一个必然 404 的全 `301`）
  ⇒ 「双 origin、两份 IndexedDB」这条风险**已收**，处置 ② 是人在 CF 侧做完的；② apex 在浏览器形状请求下的
  **Web Analytics 注入已不出现**（apex 三次 + 别名两次全是 1,455 B，`cloudflareinsights` / `beacon` 零命中）。
  `--mode=browser` 这个开关照旧留着 —— 它的理由是「平台可能改写 HTML」，不是「apex 一定被改写」。
- 文档同轮同步：ops §7 两处 `www` / `522` 交叉引用改为已收、§13 别名链补 `8b5659f6`（并写明第五轮的没记下来）、
  新增本轮 5 条实测、删掉「没做到的」里那条已被推翻的 `www` 长条目、推广入口地址的前置从三条减到两条；门禁复核：
  无 CR、无连续空行、末尾无换行、`longLines>140` 仍是 **13** 条且与 HEAD 逐条等长（没有新增）。

## 2026-10-15 反馈渠道轮（两枚 href · 8 字段计数白名单 · 三道闸门）

- 需求：给 code-map 加反馈入口，形状照 Event_Logger 的 contact 层（顶栏按钮 → 只读面板 → 用户自己点的链接）。用户
  当场拍两件事：① 渠道 = **GitHub Issues（公开）+ mailto 别名（私密）**，这**推翻** ops §10 台账 2026-10-13 那条
  「只用 GitHub Issues」，同一轮把 §9/§10 一起改写；② 回复身份 = A+B —— 专用一次性 destination（名字带产品、可
  丢弃），面板里明说「回信来自一个个人邮箱、不是这个地址」，Issues 仍是主渠道。隐私差异在面板上就写清，不等人踩。
- 形状定死：页面对外**只有两枚 `<a href>`**，没有任何 `fetch`/beacon/`<form>`/`window.open`/剪贴板写入。诊断文本
  是**冻结的 8 字段白名单**（`build, ua, files, funcs, edges, unresolved, warnings, persisted`，顺序即契约），
  而且只吐计数：数组取 `.length`、非有限数字退化为 `0`、`persisted` 非 `true/false/'yes'/'no'` 一律 `unknown`。
  选白名单而不是黑名单的理由：文件名/函数名/代码原文**在结构上进不了**这段文本，而不是「我记得没写」。无 `lang`
  字段（全站英文、无 i18n 字典）。
- `build` 不烧进产物：运行时从正在执行的 `<script src="…/entry-<hex>.js">` 取哈希**前 8 位**，取不到 → `unknown`
  （`npm run web` 的 Metro dev bundle 不带哈希，dev 下显示 unknown 是预期）。刻意只取 8 位，因为公开仓审计的
  `opaque-32-hex-id` 会命中完整 32 位十六进制。本轮 `git grep --untracked` 复验：除 `dist/` 之外零处出现完整哈希。
- 门控：`CONTACT_EMAIL = null`。理由是 Email Routing **未开通**，且本机无 Cloudflare 凭据、无 wrangler（实测），
  这轮没人能验证信到不到。关闭态下面板不渲染地址块/mailto/「没有邮件客户端怎么办」提示，`mailtoUrl()` 直接返回
  `null`；G5 断言 `<a>` 数 == 1、`feedback-email` 不存在、面板文本里连 `@` 都没有。别名在仓库里只出现在 ops §9
  （README、ADR-0003、本条都不写它），开通是后续独立一轮：8 步 runbook 落 ops §9，第 5 步「必须真发一封测试信
  确认到达，控制台显示 verified 不算证据」，第 7 步才改常量、**同一提交**补 `--public-address=` + §10 + log.md。
- 冒烟 G1–G6 插在 F 组之后、E 组之前（断言 41 → **47**）：这样 G 期间真发生的任何请求都会被 E1–E8 一并审计，
  「打开反馈面板不发出任何东西」是被同一批请求计数证明的（G2：开→关整个来回 `netRequests.size` 9→9），不是新立
  一组自说自话的断言。两枚链接一律只读 `getAttribute('href')`、**绝不点击** —— 一点就交给外部协议处理器或触发
  跨源导航，run 会挂住、E1 会红，还留个对话框害掉后面每一步。G3 把面板里的 `build` 与 `expectIndex.entry` 的前
  缀比死：改源码不改产物会红，面板报别的版本也会红。
- 草稿残影：清状态写在 render 期（`if (open !== wasOpen) { setWasOpen(open); … }`）而不是 `useEffect`。effect
  清草稿会先渲染出一帧上一轮的残影，这是 Event_Logger 的 panel.md 里**实测**被 CI headless Chrome 抓到的那一帧；
  effect 只留异步采样（`hasSession` / UA / build）。连带两条同源的坑：G1 就绪判据必须是「元素存在」而不是「文本
  以 `build=` 开头」（残留草稿同样满足后者）；`autoText` 的 `useMemo` 依赖只能是原始值（`diag.files`、`diag.funcs`
  …），依赖 `diag` 对象会被 TopBar 解析期的高频重渲打掉。重新打开丢弃草稿、重新采样；一旦用户动过文本，两枚链接
  都带改后的内容。
- 本轮最值钱的一条只有真浏览器能发现：面板在 DOM 里、`getBoundingClientRect` 坐标正确、诊断文本也对，截图里却
  看不见它，点「关闭」点到了图上。根因：RNW 的 `View` 基础样式写死 `position: relative` + `zIndex: 0`（实测
  `node_modules/react-native-web/dist/exports/View/index.js` 的 `baseStyle`）⇒ **每一个 View 都是一个层叠上下文**；
  `#topbar` 自己就是 `z:0` 的一层，遮罩的 `z-index: 1000` 只在这层内部比大小。实测 `elementFromPoint` 打在面板中心
  返回 `svg#graph-svg`。修法：顶栏 `zIndex: Z_INDEX_AUTO`，顺带放开了同样被困住的 chipTooltip（图标轮之前就存在的
  潜在 bug）。**jsdom 没有布局，单测抓不到这个** ⇒ G6 把「关闭按钮中心的命中测试必须是它自己」写成断言，这类事
  由冒烟拦，不靠 review 自觉。
- 三道闸门，缺一不可：① 静态扫描器 `scripts/audit-egress.mjs`（从 skill 逐字拷入后跑过一次 prettier ——
  `.prettierignore` 不含 `scripts/`，不先格式化则 `npm run format` 会改它），CI `checks` job 在 Invariants 之后、
  Build web bundle 之前加 blocking 步骤 `npm run audit:egress`（不加 `continue-on-error`、不动 `needs`）；它是
  **纯文本**匹配，注释里也算，所以禁用别名期间那三个被扫的文件连注释都不许出现别名、`<form`、`new Image(`、`fetch(`。
  ② jest 金丝雀 `__tests__/feedback.test.tsx`（27 例）：把塞满显眼秘密（中文文件路径、函数名、告警原文、含非
  ASCII 的代码原文）的来源喂进去，断言这些 needle 在诊断文本、Issues href、mailto 三种输出里一个都不出现，再加
  幂等、脏输入、600/160/64 长度预算、URL 形状（`&`→`%26`、空格→`%20` 不是 `+`）、门控渲染、`wasOpen` 重开回
  自动值。③ 冒烟 G 组。外加一条反向不变量：`mailto:` 在产品源码里只可能出现在 `src/feedback/contact.ts` ——
  本轮 `git grep` 实测只有那一条命中；本仓没有 Help 面板，所以 panel.md 的「Help 保持干净」在这里落成「不许长出
  第二条联系路径」。
- 一处刻意的不做：不做「复制诊断」按钮。`navigator.clipboard` 就是这条路上唯一被承诺掉的外发能力，地址改用
  `user-select: all` 让用户三击自己复制。面板用原生 `<div>`/`<a>`/`<textarea>`（AppRoot 已有原生 `<div>` 先例），
  既绕开 RNW 类型里没有 `href`/`hrefAttrs` 的 cast，也让扫描器的 `href=` 文本判据成立。
- 入口：顶栏 `topbar-feedback` ghost 按钮，放在 scope 段之后、`Clear` 之前（`Clear` 出现/消失不会让它跳位）。
  **故意不读 `busy`**：它是只读入口，解析中和从本机 IndexedDB 恢复出旧会话时都必须能点 —— 盯着那份恢复出来的
  旧版本看的人正是最需要报 bug 的人；源码里留了注释，否则下一次重构会顺手「修好」它。`feedback.test.tsx` 里也锁了
  这条（`status: 'parsing'` 时 `topbar-upload` 禁用而 `topbar-feedback` 不禁用）。`TopBar` 自持 `showFeedback` 状态
  （已有 `ctxMenu`/`hoveredChip` 先例），不改 `AppRoot` 签名；面板只收 props，不写 store、不订阅 store，降级态也
  能渲染。
- 持久层新增 `hasSession()`：复用 `loadSession` 的同一个开库路径，但用 `getKey(KEY)` 而不是 `get`（**不读
  payload**），任何异常一律 `resolve(false)`，绝不把 reject 抛进面板。坑：jest 的 `moduleNameMapper` 会把 persist
  换成 `__mocks__/persist.js`，漏补 `hasSession` 就是 TypeError，已同步补 mock。
- 门禁（本轮全部实跑，不是引用上一轮）：`npm run verify` → typecheck 0 + lint 0 error / 12 warning（均为既有）
  + jest **17 suites / 280 tests** 全绿；`npm run audit:egress` → `clean: no egress primitive, no unpublished
  address`、exit 0；`npm run smoke` → **47/47 PASS**、请求集 9 个全同源全 GET 零请求体零 4xx、E7 零命中、
  E8 零 CSP 违规、`console errors/warnings = []`、页面异常 0。G4 实测 `diag=3/45/49/26/0/unknown` 与
  `page=3/45/49/?/bar=false` 自洽（files/funcs/edges 对 chips/graph-node-/graph-edge- 元素数；unresolved 没有
  页面对端，只断言 ≥ 0）。
- 产物基线变化：入口 `entry-dd0b2e36….js` → `entry-841acd7d….js`；`index.html` sha256
  `05acbf08114b0e3cfeaf5d2eecffce1836a24b12c886473a33cf136c31955f0a` →
  `e62cf05bf468e3a63f19c4c90eafded6ea2633d643595a1e67fcb9c688f10056`，字节数仍是 1455B（新增的是**源码**，不是
  `<head>` 标签）；HTML 里仍**零个** `https?://` —— Issues 的地址只活在 bundle JS 里，那条门禁量的是 HTML。
- 一条**既有**文档漂移被 G4 逼出来：面板/冒烟实测 `edges=49 unresolved=26`，而 ADR-0002 与 README 手动清单写
  「边 47 / 未解析 28」。49/26 是 `__tests__/parser.wasm.test.ts:81` 逐字断言的现行回归基线（本轮没动
  `src/parser/`、`src/graph/`、`fixtures/`，且该套件是真跑过不是 `public/wasm` 缺失时的整文件跳过）；47/28 是
  保守解析那一轮的旧记录。本轮**两个数都不碰**，只把矛盾与判据写进 ops §4 —— 修订旧文档要另外在浏览器里重测一遍，
  静默改写数字比把矛盾摆着更糟。另：`persisted` 两次实测分别读到 `yes` 与 `unknown`，取决于会话写入与采样先后，
  所以 G4 只断言取值域，ops §4 两次读数都留着。
- 文档同轮：ops 744 → **831** 行（§1 承诺表加一行 href-only、§4 加反馈轮实测块、§9 从「打算用」改写成「已实现 +
  8 步启用 runbook + 回滚顺序：删规则 → 删 destination → Disable Routing，Pages 的 CNAME 完全不在这条路径上」、
  §10 台账改写为双渠道 + 回复身份 A+B + 「Email Routing 未开通」实测行），`longLines>140` 13 → 16；README
  316 → **376** 行（顶栏 ASCII 图加「反馈」、新增 `## 反馈渠道` 节：两条渠道的隐私差异、8 字段白名单、11 个
  `data-testid` 锚点即契约、三道闸门、门控与 runbook 指向 ops §9、ADR-0003 链接；目录结构/命令表/冒烟组表 G 行/
  47 项断言/测试表/手动验收清单同步），`longLines>140` 6 → 7；新增 `docs/adr/0003-feedback-channel-href-only.md`
  148 行（Accepted，含「这三道闸门真的在拦」的证据表与回归基线块）。目标邮箱地址**永不**进仓库/历史/文档，只存在
  Cloudflare 控制台的 Destination 字段。
- 反馈这一轮的落地范围：代码只落内网 `master`；公开镜像按 ops §11 走独立一轮（临时目录 clone → scrub
  `AGENTS.md` → `--orphan` 单提交 → noreply 身份 → `audit-public-repo.mjs --history` 必须 0 findings →
  推 `main` → CI 构建/冒烟/部署）。开工前按 AGENTS.md 复验过 `origin/master...HEAD` = 0/0。
- [实测] 推完内网后 `gh run list` 复核：`ci-and-deploy` 对 `8720972` 的 run 是 `completed / skipped`（上一个
  `a36b598` 同样 skipped）。原因不是坏了，是每个 job 都带 `if: github.repository ==
  'microsheen/python-code-map'` 的 Route B 归属守卫，而内网那份仓的 owner/name 与它不同（实例名与账号
  名按纪律不写在这里，同 ops §13）⇒ 整条 workflow 直接跳过。后果要说清：`8720972` 新加的 blocking
  步骤 `npm run audit:egress` 到 `f2f3267` 为止只有**本地** exit 0 的记录，CI 侧一条执行记录都没有 —— 内网的
  run 永远 `skipped`，所以它的第一次真执行只能发生在推给公开归属的那次 run 上。这条不是遗漏，是这台机器的仓库
  形状决定的；但在那次 run 变绿之前，不要把「CI 在拦这道闸门」当成既成事实。
