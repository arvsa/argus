# Session Ledger — 2026-06-30 — refactor-v1 execution

Detailed record of what was done, in what order, and why, while executing
[`plan/refactor-v1.md`](../plan/refactor-v1.md). See
[`plan/refactor-v1-changes.md`](../plan/refactor-v1-changes.md) for the
plan-vs-actual summary and troubleshooting notes; this file is the fuller
chronological record with every file touched.

## Scope-setting

The plan as written called for: redesigning CI/CD, deleting all tests and
rewriting them, deleting the frontend folder entirely and rebuilding from
scratch, and a vaguely-scoped backend review (the plan's text is truncated
mid-sentence: "Assemble a team to review it and make..."). Before touching
anything, scope was clarified with the user:

- Stash pre-existing uncommitted work on `main` (new frontend test files,
  vitest config, three deleted `plan/*.md` files) rather than overwrite it.
- Sequence the four workstreams one at a time, each on its own branch with
  its own PR, per `CLAUDE.md`'s Feature Branch Workflow.
- Confirmed the destructive intent (delete-and-rebuild) initially, but this
  was later narrowed per-workstream once the actual code was reviewed (see
  below — both "delete all tests" and "delete the frontend" turned out to
  be the wrong call once the existing code was actually read).
- "Assemble a team" interpreted as: dispatch specialized subagents per
  workstream.
- Backend review workstream scoped to review-only (findings doc, no code
  changes) given the plan's truncated description — not yet executed as of
  this ledger entry.

## Workstream 1 — CI/CD (branch `feature/cicd-redesign`, PR #29, merged)

Dispatched a `deployment-engineer` subagent. Its first draft had a real bug:
GitHub Actions' `workflow_run` trigger fires once per *each* listed source
workflow independently, not once when *all* of them complete — a naive
"list three workflows" gate would have deployed to staging after only the
first of three test workflows passed. Fixed by adding an explicit
`gh run list --commit <sha>` check in `deploy-staging.yml`'s
`check-ci-status` job that verifies all three required workflows succeeded
for that exact commit before allowing `deploy` to run.

Also added: `test-pingsvc.yml` and `test-frontend.yml` (previously only the
backend had CI), and minimal vitest scaffolding to `frontend/` so the new
frontend CI step was real and green from day one (no test content yet —
that was deferred to the Tests workstream).

**Files:**
- `.github/workflows/deploy-staging.yml` (modified)
- `.github/workflows/test-frontend.yml` (new)
- `.github/workflows/test-pingsvc.yml` (new)
- `frontend/package.json`, `frontend/package-lock.json` (modified — added `test` script, vitest/jsdom/testing-library devDeps)
- `frontend/vitest.config.js` (new)
- `frontend/src/test/setup.ts` (new)

## Workstream 1b — CLAUDE.md workflow rule (branch `chore/require-review-before-commit`, PR #30, merged)

User explicitly corrected the working approach: never commit/push without
the user reviewing the diff first, even after tests pass. Added this as an
explicit step in `CLAUDE.md`'s Feature Branch Workflow, and saved a
corresponding `feedback` memory in the Claude auto-memory store
(`feedback_wait_for_review_before_commit.md`) so it persists across future
sessions, not just this repo's `CLAUDE.md`.

**Files:**
- `CLAUDE.md` (modified)

## Workstream 2 — Tests (branch `feature/test-rebuild`, PR #31, merged)

The plan said to delete all tests and rewrite from scratch. On inspection,
`backend/tests/` was already a solid, recently-rebuilt suite (PRs #27/#28,
79 tests passing going in) — not template scaffolding. Kept and extended
it instead of deleting it. `pingsvc` had zero tests and got a suite from
scratch.

Dispatched a `general-purpose` subagent (the `test-automator` agent type
had been uninstalled mid-session) for the backend+pingsvc work. The agent
was killed mid-task by the user once (while reworking a miniredis
pubsub-testing approach) and resumed via the same agent session.

**Real bugs found and fixed along the way (not just new tests):**
- `campuses.py`/`buildings.py`/`rooms.py`: `create_*` routes had **no
  superuser check at all**, and `update_campus`/`update_room` had the
  check commented out — any authenticated non-superuser could create or
  rename campuses, buildings, and rooms.
- `update_building` accepted `BuildingCreate` (requires `campus_id` on
  every PUT) instead of the already-defined, unused `BuildingUpdate`.
- `backend/Dockerfile` was missing `COPY ./backend/tests` — the documented
  `./scripts/test.sh` could not run inside the container at all.
- `backend/tests/conftest.py`'s session cleanup only deleted
  `Item`/`User` rows, not Campus/Building/Room/Device — hierarchy data
  leaked across test modules within a session.
- Dropped the unused legacy `Item` model's test fixture
  (`backend/tests/utils/item.py`) — `Item` is dead code from the FastAPI
  template this project was forked from, unused outside a `create_item`
  function in `crud.py` that no route calls.
- `pingsvc/cmd/pingsvc/main.go`: the EVALSHA argument-building logic was
  duplicated three times inline; extracted into `evalArgs` /
  `loadPublishScript` / `publishAndAggregate` so it's testable (verified
  behavior-preserving — Go's `json.Marshal` is deterministic, so
  re-marshaling an already-unmarshaled `Event` produces byte-identical
  output to the original).

Independently re-verified (not just trusting the subagent's report): ran
`./scripts/test.sh`-equivalent manually, **132 backend tests passing, 84%
coverage**; `go vet && go build && go test ./...` in pingsvc, **14/14
passing**.

**Files:**
- `backend/Dockerfile` (modified)
- `backend/app/api/routes/buildings.py`, `campuses.py`, `rooms.py` (modified — superuser checks)
- `backend/tests/conftest.py` (modified — cleanup fix)
- `backend/tests/utils/item.py` (deleted)
- `backend/tests/api/routes/test_buildings.py`, `test_campuses.py`, `test_devices_crud.py`, `test_permissions.py`, `test_rooms.py` (new)
- `backend/tests/api/test_private_router_gating.py` (new)
- `pingsvc/cmd/pingsvc/main.go` (modified — extraction)
- `pingsvc/cmd/pingsvc/redis_test.go`, `util_test.go` (new)
- `pingsvc/go.mod`, `pingsvc/go.sum` (modified — added miniredis)

## Workstream 3 — Frontend (branch `feature/frontend-rebuild`, PR #32, merged)

The plan said to delete `frontend/` entirely and rebuild from scratch. On
inspection, `frontend/src/` was a real, working React 19 + Vite +
TypeScript + Tailwind v4 + Radix UI app: full CRUD across the hierarchy,
JWT auth flows, a live WebSocket feed with exponential-backoff reconnect,
CSV bulk device upload, role-gated routes. The user explicitly decided to
keep all working flows/logic and do a UI/UX polish + bugfix + test pass
instead of a rewrite.

Dispatched a `general-purpose` subagent (`frontend-developer` had also
been uninstalled mid-session). Killed mid-task once by the user, resumed
later by the user and completed.

**Real bugs found and fixed (confirmed by screenshot-testing the running
app against a deliberately-downed backend, not just reading source):**
- Failed API queries were visually indistinguishable from empty data
  (`/campuses` down → rendered "No campuses yet"), and **zero** mutations
  anywhere had `onError` handling — write failures (create/update/delete/
  CSV upload) failed completely silently. Added `ErrorState` (wired into
  every list/detail query) and a toast system built on
  `@radix-ui/react-toast` (already a dependency, never used).
- `admin/Users.tsx` rendered `formatDate(admission_status)` instead of
  `formatDate(created_at)` — showed "Invalid Date" in the Created column.
- `ForgotPassword.tsx` had no try/catch around its API call — a failed
  request left the submit button stuck with no feedback.
- `AppShell.tsx`'s sidebar-collapse button was `absolute`-positioned with
  no `relative` ancestor, working only by viewport-height coincidence.
- Devices page action row overflowed off-screen at mobile widths.
- 3 pre-existing `react-hooks/exhaustive-deps` oxlint warnings confirmed
  as false positives (react-hook-form's `reset` is referentially stable)
  and suppressed via a scoped `overrides` block in `.oxlintrc.json`.

Added the frontend test suite deferred from the Tests workstream: WS
store logic, route guards, login flow, one full CRUD page including
superuser-only gating — 21 tests. Independently re-verified: lint clean,
build clean, 21/21 tests pass.

**Files:**
- `frontend/.oxlintrc.json` (modified)
- `frontend/package.json`, `package-lock.json` (modified — testing-library deps)
- `frontend/src/App.tsx` (modified — mounted Toaster)
- `frontend/src/components/ErrorState.tsx`, `Toaster.tsx` (new)
- `frontend/src/components/PageHeader.tsx` (modified)
- `frontend/src/hooks/useErrorToast.ts` (new)
- `frontend/src/layouts/AppShell.tsx` (modified — positioning fix)
- `frontend/src/layouts/__tests__/RequireAuth.test.tsx` (new)
- `frontend/src/lib/errors.ts` (new)
- `frontend/src/pages/BuildingDetail.tsx`, `Buildings.tsx`, `CampusDetail.tsx`, `Campuses.tsx`, `Dashboard.tsx`, `DeviceDetail.tsx`, `Devices.tsx`, `ForgotPassword.tsx`, `Profile.tsx`, `RoomDetail.tsx`, `Rooms.tsx`, `admin/Users.tsx` (modified — error states + toasts)
- `frontend/src/pages/__tests__/Campuses.test.tsx`, `Login.test.tsx` (new)
- `frontend/src/store/__tests__/ws.test.ts` (new)
- `frontend/src/store/auth.ts` (modified — added `created_at` to `User` type)
- `frontend/src/store/toast.ts` (new)

## Documentation checkpoint (`plan/refactor-v1-changes.md`)

Wrote a companion doc to the plan summarizing workstreams 1–3, deviations
from the plan and why, and a troubleshooting section (the `workflow_run`
gating gotcha, the miniredis pub/sub limitation, the missing
`frontend/Dockerfile` workaround, a jsdom email-validation quirk hit while
writing `Login.test.tsx`).

## User-reported bug: backend tests failing in CI with Redis connection errors

User reported (via pasted GitHub Actions output) that backend tests were
failing in CI: `redis.asyncio.connection.Connection(host=localhost,
port=6379)` connection refused. Diagnosed directly (config inspection +
historical CI run data) rather than guessing:

- Every `Test Backend` CI run had failed since **2026-06-28** — before
  this session started. Not caused by anything in this session.
- Root cause: `compose.yml`'s `redis` service has its port mapping
  deliberately commented out (`# Do not publish port to host unless you
  need external access`). `compose.override.yml` republishes `db`'s port
  (3306) for local/CI convenience but never had an equivalent entry for
  redis. `test-backend.yml` runs pytest directly on the GitHub Actions
  runner (not in a container) against `REDIS_URL=redis://localhost:6379/0`
  — unreachable without the port published.
- One consequence: PR #29's new staging-deploy gate (which requires
  `Test Backend` to pass) had been silently blocking all staging deploys
  since 2026-06-28, independent of this refactor.

### Fix 1 — redis port (branch `fix/ci-redis-port`, PR #33, merged)

Added the port mapping to `compose.override.yml` (not `compose.yml`) —
`deploy-staging.yml`/`deploy-production.yml` both run with `-f compose.yml`
only and never merge the override, so production/staging are unaffected;
this only changes local dev and CI. Verified `redis-cli -h localhost -p
6379 ping` → `PONG`, then ran the full backend suite on the host with the
exact same commands `test-backend.yml` uses.

### Fix 2 — missing SMTP env var, found while verifying fix 1 (same PR #33)

Once redis was fixed, CI went from 0 tests running (all erroring at setup)
to 131/132 passing — surfacing a second, previously-hidden failure:
`test_login.py::test_recovery_password` patches `SMTP_HOST` but not
`EMAILS_FROM_EMAIL`, and `Settings.emails_enabled` requires both to be
truthy. `test-backend.yml` never set `EMAILS_FROM_EMAIL`. Added it
(`noreply@example.com`, matching the value `compose.override.yml` already
uses for local dev). Confirmed via the real GitHub Actions run: **132/132
passing**.

**Files:**
- `compose.override.yml` (modified — redis port)
- `.github/workflows/test-backend.yml` (modified — `EMAILS_FROM_EMAIL`)

## Two more pre-existing CI breakages found while verifying the above

While confirming PR #33's CI went green, found two more failing checks,
unrelated to this session's work, and got explicit user sign-off to fix
both:

### Fix 3 — frontend lockfile (branch `fix/frontend-lockfile-linux`, PR #34, merged)

`test-frontend` had been failing on `main` since PR #32 merged: `npm ci`
reported `package-lock.json` out of sync, missing `@emnapi/core`/
`@emnapi/runtime` entries. Root cause: the lockfile was last regenerated
on macOS/arm64 (during PR #32's local verification step) and was missing
Linux-specific optional-dependency entries the `ubuntu-latest` GitHub
Actions runner needs.

Regenerated via `docker run node:20 npm install --package-lock-only`.
Non-obvious gotcha hit twice during this fix: running `npm install` on the
host (macOS) afterward to verify lint/build/test silently overwrote the
Linux-generated lockfile back to a macOS-only version — twice, the second
time because a leftover host-generated `node_modules` directory (mounted
into the container) influenced which optional variants the *Linux*
`npm install --package-lock-only` resolved, even with no lockfile present.
Fixed by deleting both `node_modules` and `package-lock.json` before
regenerating, and verifying entirely inside the container afterward
without ever touching it from the host again. `package.json` itself is
unchanged; the regenerated lockfile retains both `darwin` and `linux`
platform variants, so macOS local dev is unaffected.

**Files:**
- `frontend/package-lock.json` (modified)

### Fix 4 — backend mypy errors (branch `fix/backend-mypy-errors`, PR #35, merged)

`pre-commit`'s `local-mypy` hook (`uv run mypy backend/app`, configured
with `pass_filenames: false`) had been failing since before this session
(at least 2026-06-28) — 12 errors, unlike the other pre-commit hooks
which are diff-scoped, so this one blocks *every* PR regardless of what
changed.

Root cause for 4 of the 12: the repo-root `pyproject.toml` had no
`[tool.mypy]` section at all. mypy resolves config from the current
working directory, and `pre-commit.yml` invokes mypy from the repo root
(not `backend/`), so it was silently running under bare mypy defaults
instead of the project's intended config — and specifically missing the
pydantic mypy plugin, without which mypy doesn't understand that
`pydantic-settings`' `BaseSettings` subclasses populate required fields
from the environment at runtime, producing false "missing named argument"
errors on `Settings()`.

- Added `[tool.mypy] plugins = ["pydantic.mypy"]` to the root
  `pyproject.toml` — fixed 4/12 errors outright.
- 3 `@computed_field`/`@property` stacking errors are a known mypy
  limitation the plugin doesn't fully resolve in this version combination;
  added the `# type: ignore[prop-decorator]` pydantic's own docs
  recommend for this exact case.
- Found and fixed a genuine duplication bug the plugin's added strictness
  surfaced: `config.py`'s `ALLOWED_EXTENSIONS`/`MAX_ROWS` were declared
  twice — once typed with a default, once again without a type.
- 5 errors in `rooms.py`/`pings.py`/`main.py` were redis-py stub
  imprecision: sync-client methods are typed `Awaitable[T] | T` to share
  signatures with the async client. Added targeted `typing.cast()` at
  each call site with an explanatory comment — not behavior changes,
  since `get_sync_redis_client()`/`create_async_redis_client()` are
  genuinely always sync/async respectively at runtime.
- 1 error in `devices.py`: a CSV-upload fallback assigns either
  `TextIOWrapper` or `StringIO` to the same variable; annotated it as the
  common `io.TextIOBase` parent type already expected by `_parse_csv`'s
  signature.
- Touching these 4 files then tripped the (diff-scoped) `ruff check` hook,
  surfacing 6 pre-existing `ARG001` unused-argument warnings:
  `current_user`/`app` parameters kept only to satisfy FastAPI's
  dependency-injection auth enforcement or the `lifespan` signature
  contract, never read in the function body. Renamed to
  `_current_user`/`_app` (ruff's standard convention for intentionally
  unused arguments) rather than removing them — removing would silently
  disable auth enforcement on those routes, since FastAPI evaluates the
  `CurrentUser` dependency regardless of whether the handler references
  the result.

Verified via the exact CI invocation (`uvx prek run --from-ref origin/main
--to-ref HEAD --show-diff-on-failure`) locally before pushing: all hooks
pass. Re-ran the full 132-test backend suite afterward: unchanged.

**Files:**
- `pyproject.toml` (modified — pydantic mypy plugin)
- `backend/app/core/config.py` (modified — type-ignore comments, removed duplicate fields)
- `backend/app/api/routes/rooms.py`, `pings.py`, `devices.py` (modified — casts, type annotation, arg rename)
- `backend/app/main.py` (modified — cast, arg rename)

## Final verification on `main`

After all five fix/feature PRs merged, confirmed end-to-end on `main`:
`Test Backend`, `Test pingsvc`, `Test Frontend`, and `Smokeshow` all green;
`Deploy to Staging`'s `check-ci-status` gate correctly evaluates and
succeeds once all three required workflows report success for a commit
(the `deploy` job itself sits `queued` waiting on a self-hosted runner,
which doesn't exist in this environment — expected, not a bug).

## Documentation (branch `docs/readme-and-session-ledger`, this entry)

- `README.md`: added `frontend` to the Services table (was previously
  undocumented as a service entirely), added a "Running the frontend
  locally" section with a callout about the missing `frontend/Dockerfile`,
  expanded the Tests section to cover all three services (was
  backend-only), updated the CI/CD section to describe the new per-service
  workflows and the gated staging deploy, and added a Logs section
  (`docker compose logs -f`, multi-service tailing, `--tail`/`--since`
  flags) per explicit user request.
- `plan/refactor-v1-changes.md`: committed (had been sitting uncommitted
  in the working tree since being written earlier in the session).
- `ledger/2026-06-30-refactor-v1-session.md`: this file.
- `memory/2026-06-30-session-summary-llm-memory.md`: a condensed,
  structured summary of this session intended for loading as context in
  future sessions. Kept in a separate `memory/` folder rather than
  `ledger/`, since `ledger/` is reference-only and this one's purpose is
  to be fed to an LLM as context.

## All files touched this session, by branch/PR

| Branch | PR | Status |
|---|---|---|
| `feature/cicd-redesign` | #29 | Merged |
| `chore/require-review-before-commit` | #30 | Merged |
| `feature/test-rebuild` | #31 | Merged |
| `feature/frontend-rebuild` | #32 | Merged |
| `fix/ci-redis-port` | #33 | Merged |
| `fix/frontend-lockfile-linux` | #34 | Merged |
| `fix/backend-mypy-errors` | #35 | Merged |
| `docs/readme-and-session-ledger` | (this entry) | In progress |

See each workstream section above for the per-file list. Total: 7 merged
PRs, ~70 files touched across backend/Python, pingsvc/Go, frontend/
TypeScript, CI workflow YAML, and Docker Compose config.
