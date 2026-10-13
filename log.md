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
