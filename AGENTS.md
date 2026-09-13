# AGENTS.md — code-map

## Agent skills

### Issue tracker

Issues live in GitHub Issues (GitHub Enterprise: `<internal-gh>`). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` at root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Git 操作规则

### 文件编码损坏处理

当遇到文件编码损坏导致变更未提交的情况时，**不要自行执行 git checkout 恢复文件**。必须先向用户确认如何处理，避免意外丢失未提交的变更。

### 开始修改前同步代码

每次新会话开始修改代码之前，必须先执行以下两步：
1. git pull — 将远程仓库的最新代码同步到本地
2. git push — 将本地已有的提交同步到远程仓库

确保本地和远程代码完全一致后，再开始修改代码，避免后续提交时产生冲突或遗漏。
