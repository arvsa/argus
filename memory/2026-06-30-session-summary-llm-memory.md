---
date: 2026-06-30
purpose: condensed session summary for loading as context in future sessions
full_detail: ledger/2026-06-30-refactor-v1-session.md
related_plan: plan/refactor-v1.md
---

# Session Summary — 2026-06-30 — argus refactor-v1

## What happened, in one paragraph

Executed `plan/refactor-v1.md` (CI/CD redesign, test rebuild, frontend
rebuild, backend review). Two of the plan's four items as literally
written ("delete all tests," "delete the frontend folder") turned out to
be wrong calls once the actual code was reviewed — both backend tests and
the frontend were already solid, working code, not disposable scaffolding.
Scope was narrowed accordingly with the user's explicit sign-off at each
step. Along the way, fixed four separate pre-existing, CI-blocking bugs
that predated this session (redis port not published to CI host, missing
SMTP env var, macOS-generated frontend lockfile incompatible with Linux
CI runners, and 12 mypy errors silently masked by a missing pydantic mypy
plugin). Ended with 7 merged PRs and a fully green `main` branch CI
pipeline, verified end-to-end.

## Key facts worth remembering

- **This repo's existing code is generally higher quality than its own
  planning docs assume.** Both `backend/tests/` and `frontend/src/` were
  described as weak/minimal in `plan/refactor-v1.md`, but were actually
  solid and working. Read the actual code before trusting a plan's
  framing of "what's broken."
- **`pre-commit.yml`'s `local-mypy` hook is whole-repo scoped**
  (`pass_filenames: false`), unlike the ruff hooks which are diff-scoped.
  Any mypy error anywhere blocks every PR's pre-commit check, regardless
  of what that PR actually touched.
- **Root `pyproject.toml` had no `[tool.mypy]` config** before this
  session (now has the pydantic mypy plugin enabled). `backend/pyproject.toml`
  has its own stricter `[tool.mypy] strict = true`, used by
  `bash scripts/lint.sh`, which is a *different, stricter* invocation than
  what CI's pre-commit hook runs.
- **`compose.override.yml` publishes `db`'s port (3306) but historically
  not redis's** — now fixed (redis 6379 added). `compose.yml` itself
  deliberately does NOT publish redis's port (security comment in the
  file) — don't "fix" it there; the override is the right place, since
  production/staging deploys (`deploy-staging.yml`/`deploy-production.yml`)
  run with `-f compose.yml` only and never merge the override.
- **`frontend/Dockerfile` does not exist**, despite `compose.override.yml`
  referencing one. `docker compose build` for the full stack fails until
  it's added. Known issue, documented in the README, not yet fixed.
- **Regenerating `frontend/package-lock.json` on macOS silently breaks
  `npm ci` on Linux CI runners** (missing platform-specific optional-dep
  entries like `@emnapi/core`). Must regenerate inside a Linux container
  (`docker run node:20 npm install --package-lock-only`) — and a stale
  host-generated `node_modules` directory will poison even that if not
  deleted first.
- **`test-automator` and `frontend-developer` agent types were uninstalled
  mid-session** (became unavailable partway through); `general-purpose`
  was used instead for the Tests and Frontend workstreams.
- **User's explicit working-style correction this session**: never commit
  or push after implementing/verifying a change — always stop and show
  the diff, wait for explicit acceptance. Now codified in `CLAUDE.md`'s
  Feature Branch Workflow and saved as a persistent feedback memory
  (`feedback_wait_for_review_before_commit.md` in the Claude auto-memory
  store, not just this repo).
- User also corrected/redirected agent work directly twice this session by
  killing a background subagent mid-task (once during test-rebuild, once
  during frontend polish) and later resuming the same agent rather than
  restarting — worth checking for a live/resumable agent before respawning
  if a similar interruption happens again.

## Current state of the repo as of this session

- `main` branch CI is fully green: Test Backend (132 tests, 84% coverage),
  Test pingsvc (14 tests), Test Frontend (21 tests), Smokeshow, and the
  gated staging-deploy check all pass. The `deploy` job itself stays
  `queued` because there's no actual self-hosted runner in this
  environment — expected, not a bug to chase.
- Backend review workstream (plan item 4) has **not** been executed yet —
  scoped as review-only (findings doc, no code changes) per user
  agreement, but not started as of this summary.
- `ledger/` is a new top-level folder in this repo, created this session,
  intended as an ongoing dated changelog of significant work sessions —
  check it for prior context before starting new work here.

## Where to look for more detail

- `ledger/2026-06-30-refactor-v1-session.md` — full chronological record
  with every file touched, organized by PR/branch, including the
  troubleshooting notes (gotchas: `workflow_run` multi-workflow gating,
  miniredis pub/sub limitation, jsdom email-validation quirk).
- `plan/refactor-v1.md` — the original plan being executed.
