# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## When api.github.com is unreachable（观测点被重置：先换客户端，再换域名）

`gh` 的每个子命令都打 `api.github.com`。这个域名在部分网络下会被间歇性重置 —— 实测症状：TCP 能连上、
TLS 之后 `wsarecv: An existing connection was forcibly closed by the remote host`，或 `UND_ERR_CONNECT_TIMEOUT`。
被重置的可能是**客户端**、**域名**或**凭据**，三者处置不同，按这个顺序排：

1. **凭据**：`git ls-remote origin` 能过就不是凭据问题（它走 `github.com`，但用的是同一份 git 凭据）。
2. **客户端**：`gh api` 被重置 **不等于** 域名不通。`[实测 2026-10-30]` 同一分钟内
   `gh api repos/microsheen/python-code-map` 报 `wsarecv … forcibly closed`，而 PowerShell 的
   `Invoke-WebRequest https://api.github.com/repos/microsheen/python-code-map` 返回 **200**；
   再带上 `gh auth token`（只读本地配置，不走网络）取出的令牌改走 `Invoke-RestMethod`，
   读 check-runs 与 job 日志**都是一次成功**。重置是按连接发生的，所以「换个客户端重试」优先于「换个域名凑合」。
3. **域名**：只有直连也被重置时，才降级到下面两条不要令牌的备胎读法。

取信息按这个顺序，别把「读不到」当成任何一种结论：

- **CI 逐 job 结论（首选）**：`GET https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs`，
  头带 `Authorization: token $(gh auth token)`、`Accept: application/vnd.github+json`、`User-Agent`（API 要求带）。
  返回每个 check 的 `name` / `status` / `conclusion` 与 job id —— 比数 HTML 图标稳，也比 `short_text` 细。
- **CI 日志正文**：`GET .../actions/jobs/<job-id>/logs`，同一套头，返回整段纯文本。
  `[实测 2026-10-30]` run 40903582359 的 `checks` job 一次取回 **49,012 B / 591 行**：node 与 npm 版本、
  eslint 逐条警告（文件、行:列、规则名）、jest 计数、`audit:egress` 输出全在里面。
  所以「日志正文拿不到」只在 `gh` 这一个客户端上成立过，不是域名级限制 —— 上一轮据此记下的
  「本轮 CI 日志不可读」，事后是可以补读回来的。
- **备胎一（不要令牌）**：`GET https://github.com/<owner>/<repo>/commits/deferred_commit_data/<sha>?original_branch=<branch>`
  带 `Accept: application/json` —— commits 页面延迟加载用的内部端点，返回 `statusCheckStatus.state`
  （`pending`/`success`/`failure`）与 `short_text`（例如 `2 / 3 checks OK`），一次能拿到整页 commit 的状态。
- **备胎二（不要令牌）**：`GET https://github.com/<owner>/<repo>/actions/runs/<run-id>` 的 HTML ——
  job 图标是服务端渲染的，数 `aria-label="completed successfully: "` / `"skipped: "` / `"failure: "`
  就是逐 job 结论。run id 从 `GET .../actions/workflows/<file>` 的 HTML 里按出现顺序抓
  `/actions/runs/(\d+)`，最新那条即本轮。两条备胎都**给不了日志正文**。
- 走备胎时在 `log.md` 里明写「本轮只拿到结论、没拿到日志」。
- **写操作**（评论、关票、改标签）：同一条 API，`Invoke-RestMethod -Method Post`（改标签用 `Patch`）带同一个令牌。
  body 传**字节**：`[Text.Encoding]::UTF8.GetBytes((@{ body = $text } | ConvertTo-Json -Compress))` ——
  直接传字符串的话编码不由你控制（这条本轮没实测，是绕开的）。`[实测 2026-10-30]` 用这条路给 issue #9 与 #3
  各补了一条评论（1,480 / 1,159 字），读回来中文完好，而当时 `gh issue comment` 仍被重置。

反面样本，别重犯：数 HTML 里 `success` / `failure` 的**词频**。实测某 run 页面里 `success` 出现 15 次、
`failure` 0 次，其中大部分是 CSS 类名与 SVG sprite id（`color-fg-success` 之类），而 `conclusion` 这个键
在 HTML 里一次都没有。先确认「这个词是从哪个结构里出来的」，再拿它当读数。

`git push` 走的是 `github.com` 的 git 端点，与 API 域名**分开抖动**：`[实测 2026-10-30]` API 侧读得通的同一时段，
`git push` 连着 6 次 `Recv failure: Connection was reset`，第 7 次才推上去。推送要写成重试循环（失败后退避几秒再试），
别一次失败就断定远程坏了；也别在循环还没跑完时就记下「推不上去」。
