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

## When api.github.com is unreachable（API 域名不通时的替代读法）

`gh` 的每个子命令都打 `api.github.com`。这个域名在部分网络下会被间歇性重置 —— 实测症状：TCP 能连上、
TLS 之后 `wsarecv: An existing connection was forcibly closed by the remote host`，或 `UND_ERR_CONNECT_TIMEOUT`；
而 **`github.com` 本身通常是通的**（`git push` 照常成功）。先分清是域名还是凭据：
`git ls-remote origin` 能过就是前者。

按下面的顺序取信息，别把「读不到」当成任何一种结论：

- **CI 状态（首选）**：`GET https://github.com/<owner>/<repo>/commits/deferred_commit_data/<sha>?original_branch=<branch>`
  带 `Accept: application/json` —— 这是 commits 页面延迟加载用的内部端点，返回 `statusCheckStatus.state`
  （`pending`/`success`/`failure`）与 `short_text`（例如 `2 / 3 checks OK`），一次能拿到整页 commit 的状态。
- **逐 job 结论**：`GET https://github.com/<owner>/<repo>/actions/runs/<run-id>` 的 HTML —— job 图标是服务端渲染的，
  数 `aria-label="completed successfully: "` / `"skipped: "` / `"failure: "` 就是逐 job 结论。
  run id 从 `GET .../actions/workflows/<file>` 的 HTML 里按出现顺序抓 `/actions/runs/(\d+)`，最新那条即本轮。
- **拿不到的**：日志正文（`gh run view --log` 走 API 域名）。所以这种网络下 CI 侧的 node/npm 版本、
  jest 与冒烟的逐条读数抄不回来 —— 在 `log.md` 里明写「本轮 CI 日志不可读」，只记能拿到的结论。

反面样本，别重犯：数 HTML 里 `success` / `failure` 的**词频**。实测某 run 页面里 `success` 出现 15 次、
`failure` 0 次，其中大部分是 CSS 类名与 SVG sprite id（`color-fg-success` 之类），而 `conclusion` 这个键
在 HTML 里一次都没有。先确认「这个词是从哪个结构里出来的」，再拿它当读数。
