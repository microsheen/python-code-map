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
