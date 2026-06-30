# refactor-v1: What Changed

Companion to [`refactor-v1.md`](./refactor-v1.md). That file is the plan; this is a record of what was
actually done, why it differs from the plan in places, and where to look when something breaks.

Status as of writing: CI/CD and Tests are merged to `main`. Frontend is open for review. Backend
review has not started.

| Workstream | Branch | PR | Status |
|---|---|---|---|
| CI/CD | `feature/cicd-redesign` | [#29](https://github.com/arvsa/argus/pull/29) | Merged |
| CLAUDE.md workflow rule | `chore/require-review-before-commit` | [#30](https://github.com/arvsa/argus/pull/30) | Merged |
| Tests (backend + pingsvc) | `feature/test-rebuild` | [#31](https://github.com/arvsa/argus/pull/31) | Merged |
| Frontend polish | `feature/frontend-rebuild` | [#32](https://github.com/arvsa/argus/pull/32) | Open |
| Backend review | not started | — | Pending |

## Where this deviated from the plan

The plan called for deleting all tests and the entire frontend and rebuilding from zero. Once the
actual state of the repo was reviewed, both calls were narrowed:

- **Tests**: the backend suite (`backend/tests/`) was already solid (rebuilt in PRs #27/#28, 79
  tests passing before this workstream touched it), not template scaffolding. It was kept and
  extended rather than deleted, since deleting working coverage to rewrite it from scratch had no
  upside. pingsvc had zero tests and got a suite from scratch.
- **Frontend**: `frontend/src/` turned out to be a real, working app (full CRUD across the
  hierarchy, JWT auth, a live WebSocket feed with reconnect/backoff, CSV bulk upload) rather than a
  minimal stub. It was kept and polished (error states, bug fixes, tests added) instead of deleted.

If you're looking for "the new frontend" or "the new test files" expecting a from-scratch rewrite,
that's not what happened — look for diffs against the original instead.

## CI/CD (PR #29)

**New workflows**: `.github/workflows/test-pingsvc.yml` (go vet/build/test) and
`.github/workflows/test-frontend.yml` (oxlint, `tsc -b`, vitest) — previously only the backend had
CI at all.

**Staging deploy gating**: `.github/workflows/deploy-staging.yml` used to fire on every push to
`main`, regardless of whether tests passed. It's now triggered by `workflow_run` on all three test
workflows completing, with a `check-ci-status` job that calls `gh run list --commit <sha>` to
explicitly verify *all three* succeeded for that exact commit.

**Troubleshooting**: `workflow_run` fires once per listed source workflow, not once when all of
them are done — a naive "list 3 workflows" trigger would deploy after only the *first* one passes.
If staging deploys look like they're firing too early or not firing at all, check the
`check-ci-status` job logs in the Actions tab — it explicitly fails (exit 1) if any of "Test
Backend" / "Test pingsvc" / "Test Frontend" hasn't succeeded yet for that SHA, which is expected
and not a bug; the workflow re-fires when the next of the three completes.

**Frontend test infra**: `frontend/vitest.config.js`, `frontend/src/test/setup.ts`, and the
`vitest`/`jsdom`/`@testing-library/jest-dom` devDependencies were added here so the new CI step
would be green from day one (`vitest run --passWithNoTests`), ahead of any real frontend tests
existing yet.

## Tests — backend + pingsvc (PR #31)

**Real bugs found and fixed while writing tests** (not just new test files):
- `campuses.py`/`buildings.py`/`rooms.py`: `create_*` routes had **no superuser check at all**, and
  `update_campus`/`update_room` had the check commented out. Any authenticated non-superuser could
  create or rename campuses, buildings, and rooms. Fixed to match the existing `devices.py` pattern.
- `update_building` accepted `BuildingCreate` (requires `campus_id` on every PUT) instead of the
  already-defined `BuildingUpdate`. Swapped the type.
- `backend/Dockerfile` was missing `COPY ./backend/tests` — the documented `./scripts/test.sh`
  could not run inside the container at all until this was added.
- `backend/tests/conftest.py`'s session cleanup only deleted `Item`/`User` rows, not
  Campus/Building/Room/Device — hierarchy data leaked across test modules within a session. Fixed
  to delete child-most tables first (FK order: Device, Room, Building, Campus, User).
- The legacy `Item` model/test fixture (`backend/tests/utils/item.py`) was dropped — `Item` is
  unused outside a dead `create_item` function in `crud.py` that no route calls. If you're looking
  for `Item` and can't find it, that's why; it's leftover from the FastAPI template this project
  was forked from, not part of the actual domain.

**pingsvc**: `pingsvc/cmd/pingsvc/main.go` had its EVALSHA argument-building logic duplicated three
times inline. Extracted into `evalArgs` / `loadPublishScript` / `publishAndAggregate` so it's
testable — verified behavior-preserving (Go's `json.Marshal` is deterministic, so re-marshaling the
already-unmarshaled `Event` produces byte-identical output to the original raw bytes). New tests in
`redis_test.go` use `github.com/alicebob/miniredis/v2` (in-memory Redis fake) and `util_test.go`
covers the pure helper functions.

**Troubleshooting**: if you add a pingsvc test asserting on Redis pub/sub channel delivery and it
mysteriously doesn't fire, this is a known miniredis limitation — `PUBLISH` called from *inside* a
Lua script via miniredis does not relay into miniredis's own pubsub dispatcher (a `client.Publish()`
call works fine; the same call from `redis.call("PUBLISH", ...)` in Lua does not). This was hit and
worked around by testing the state/counter side effects directly instead of pubsub delivery. A real
integration test against live Redis would be needed to cover pubsub delivery itself.

**Running the suite**: `./scripts/test.sh` builds and runs the *whole* compose stack including
`frontend`, which currently has no Dockerfile (see Known Issues below) — this makes the documented
one-liner fail. Until that's fixed, run the backend suite manually:
```bash
docker compose build db redis prestart backend
docker compose up -d db redis
docker compose run --rm prestart
docker compose run --rm backend bash -c "python app/tests_pre_start.py && bash scripts/test.sh"
docker compose down -v --remove-orphans
```

## Frontend polish (PR #32, open)

**Biggest issue found**: failed API calls were indistinguishable from empty data. A down backend
made `/campuses` render "No campuses yet" instead of an error, and every mutation (create/update/
delete/CSV upload) had no `onError` handler anywhere — failures were silent. Fixed with:
- `frontend/src/components/ErrorState.tsx` — wired into every list/detail page's query.
- A toast system built on `@radix-ui/react-toast` (already a dependency, previously unused):
  `frontend/src/store/toast.ts`, `frontend/src/lib/errors.ts` (extracts FastAPI `detail` messages),
  `frontend/src/hooks/useErrorToast.ts`, `frontend/src/components/Toaster.tsx` — wired into every
  mutation's `onError`.

**Other real bugs fixed**: `admin/Users.tsx` rendered `formatDate(admission_status)` instead of
`formatDate(created_at)` (showed "Invalid Date"); `ForgotPassword.tsx` had no try/catch around its
API call (failures left the button stuck with no feedback); `AppShell.tsx`'s sidebar-collapse button
was `absolute`-positioned with no `relative` ancestor; the Devices page action row overflowed at
mobile widths.

**Lint suppressions**: the 3 pre-existing `react-hooks/exhaustive-deps` warnings
(`CampusDetail.tsx`, `BuildingDetail.tsx`, `RoomDetail.tsx`) are false positives —
react-hook-form's `reset` function is referentially stable, so adding it as a dependency would be a
no-op at best. Suppressed via a scoped `overrides` block in `frontend/.oxlintrc.json` rather than
adding the dependency.

**New test files**: `frontend/src/store/__tests__/ws.test.ts`,
`frontend/src/layouts/__tests__/RequireAuth.test.tsx`,
`frontend/src/pages/__tests__/Login.test.tsx`, `frontend/src/pages/__tests__/Campuses.test.tsx`.
21 tests total. Coverage is intentionally narrow (auth, one representative CRUD page, the WS store,
route guards) rather than exhaustive across all 20+ pages.

**Troubleshooting a flaky-looking test**: if a test that submits a malformed email in a form only
fails when run alongside other tests, it's likely the same jsdom quirk hit while writing
`Login.test.tsx` — `<input type="email">` blocks the native `submit` event entirely for a non-empty
value that fails the browser's loose built-in pattern, so React's `onSubmit` (and zod validation)
never run. Use an address like `user@localhost` (passes the native check, still fails zod's
stricter pattern) instead of something with no `@` or no domain at all.

## Known issues, not fixed (out of scope for these workstreams)

- **`frontend/Dockerfile` does not exist**, but `compose.override.yml` references it. `docker
  compose build` for the full stack fails until this is added. This blocks the documented
  `./scripts/test.sh` one-liner (see workaround above) and would block a real frontend deploy.
- **No `<label htmlFor>`/`id` association** on any form input across the frontend (~15 forms). A
  real accessibility gap, found while writing `Login.test.tsx` (had to query by placeholder text
  instead of label). Not fixed — touches too much surface for a polish pass.
- **Frontend JS bundle is ~600KB**, past Vite's default chunk-size warning threshold. Would need
  route-level code-splitting (`React.lazy`); not attempted since it's a structural change.
- **pingsvc's `go.mod` module name is `example/hello`** — leftover placeholder, never renamed.
  Harmless but confusing if you go looking for `argus/pingsvc` and don't find it.

## Backend review (not started)

The plan's fourth item ("Assemble a team to review it and make...") is truncated in
`refactor-v1.md` — the sentence has no object. Scoped with the user as a review-only pass:
audit backend code quality/security/architecture, write findings to a new doc, no code changes.
Not yet started.
