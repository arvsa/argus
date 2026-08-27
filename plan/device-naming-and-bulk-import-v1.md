# Device Naming and Bulk Import

## 1. Context

This plan covers everything about a device actually having a *name* an
operator sees instead of a bare IP, entered by hand or in bulk, plus the
fully independent manual bulk-import path for static IPs. Pure
backend-read-path and frontend work; pingsvc has no role in anything in
this document.

Devices are added exclusively by an operator supplying a static IP (single
add or CSV bulk import) -- there is no discovery mechanism.

## 2. Design

### 2.1 Backend: read-time hostname enrichment

Hostname/MAC/timezone don't ride along on every ping event -- that's
slow-changing metadata, not live state, and re-broadcasting it every second
through Redis would be pure waste. Instead, `/state` (and any other
live-status read path) joins each Redis event's `device_key` (or `addr`)
against `Device` at *read* time to attach the human-facing name -- a
backend-only change, consistent with the backend already owning "how do we
present a device to a human."

### 2.2 Frontend: hostname display

`DevicePublic`/`Device` API types gain `hostname`/`mac`/`timezone`.
`AssignedDevices.tsx` and the live-status `Devices.tsx` page render
`device.hostname ?? device.addr` instead of always `addr` -- `Devices.tsx`
currently only knows live Redis-backed status keyed by address
(`CLAUDE.md`'s documented ephemeral-state-vs-persisted-assignment split),
so this needs a client-side join: fetch the `Device` list once, build an
`addr`/`device_key -> hostname` map, apply it when rendering the
live-status table (§2.1 does the equivalent join server-side for `/state`
itself; either is fine, whichever ships first -- they're not mutually
exclusive, but only one is strictly needed).

### 2.5 Manual/static device entry: name field

The manual path -- the only way a device is ever added -- needs a proper
asset-record quality, not just a bare address. `AssignedDevices.tsx`'s
"Add device" form gains an optional `hostname` input alongside `addr`.
`Device.hostname` already exists as a column on the `Device` table.

### 2.6 Bulk import: CSV upload

**Supersedes an earlier sketch** from this session's `feature/pingsvc-
target-sync` work, which proposed a plain-address-per-line textarea and a
`POST /devices/bulk` endpoint taking bare addresses. The real requirement:

- **A CSV with a header row**, not a bare address list -- at minimum
  `addr,hostname` columns, optionally `mac`/`timezone`/a node reference per
  row.
- **`.xlsx` (true Excel) parsing is a nice-to-have, not required for v1** --
  Excel exports to CSV natively, and pulling in a spreadsheet-parsing
  dependency (e.g. `openpyxl` server-side, or a JS library client-side) for
  marginal convenience is a call to make later, not assumed here.
- **Backend**: new `POST /devices/bulk-import` (superuser-gated, matching
  `POST /devices/`'s existing write gating), accepting parsed rows --
  whether the CSV is parsed client-side (simple enough to do in the
  browser before submitting JSON) or server-side is an implementation
  detail, not resolved here. Applies the exact same per-row duplicate/
  orphan-reassignment logic `POST /devices/` already has
  (`backend/app/api/routes/devices.py:96-122`), and reports a per-row
  outcome (`created`/`reassigned`/`skipped_duplicate`/`error`) rather than
  all-or-nothing -- a typo in row 40 of 500 shouldn't block the other 499.
- **Frontend**: a "Bulk import" affordance (file picker or paste-CSV
  textarea) in the devices/hierarchy UI, submitting to the new endpoint and
  rendering the per-row outcome summary, not a single pass/fail toast.

### 2.7 Deferred, explicitly out of scope for this pass

- **Name-template generation** -- e.g. `floor-1-<counter>` expanding to
  `floor-1-1`, `floor-1-2`, ... A pure frontend convenience that would
  pre-fill the `hostname` column of a CSV template (or the bulk-import form
  directly) before submission. `Device.hostname` stays a plain string
  regardless of how it got filled in -- no backend concept of a "template"
  needed when this is eventually designed.
- **`.xlsx` native parsing** (§2.6).

## 3. Phased Rollout (TDD, per CLAUDE.md)

1. **`feature/device-bulk-import`** (§2.5, §2.6) -- name field on the
   existing single-add form, `POST /devices/bulk-import` + CSV parsing +
   per-row outcome reporting. RED: a batch with a new row, a
   duplicate-address row, an already-assigned-elsewhere row, and a
   malformed row all in one upload -- confirm the three valid categories
   commit correctly and the malformed row is reported, not silently
   dropped or blocking the others.
2. **`feature/device-naming-display`** (§2.1, §2.2) -- read-time enrichment
   join + hostname display in `Devices.tsx`/`AssignedDevices.tsx`. Only
   depends on `Device.hostname` existing (§2.5's prerequisite).

Each branch: RED → implement → GREEN (`./scripts/test.sh`, frontend
`vitest`) → show diff → wait for approval → commit → push → PR, same
cadence as every other change this session.

## 4. Open Questions / Risks

- **CSV parsing location** (client vs. server) isn't resolved -- affects
  whether `POST /devices/bulk-import` accepts raw CSV text or pre-parsed
  JSON rows. Pick during step 1's implementation.
- **Column-name flexibility**: exact-match header names (`addr`,
  `hostname`, ...) vs. some tolerance for common variants (`ip`,
  `address`, `name`) -- a real usability question for anyone hand-building
  a CSV rather than using a generated template. Not designed here.
- **Large upload UX**: no pagination/streaming considered for a very large
  CSV (thousands of rows) -- worth a sanity check during implementation,
  not assumed to be a problem given `POST /devices/` itself has no such
  limit today either.

## 5. Key File Touch Points

| Area | Files |
|---|---|
| Backend | `backend/app/api/routes/devices.py` (`/state` read-time join, `POST /devices/bulk-import`), `backend/app/crud.py` (shared per-row create/reassign logic) |
| Frontend | `frontend/src/pages/Devices.tsx`, `frontend/src/components/AssignedDevices.tsx` (hostname display, name field, bulk-import UI) |
| Tests | `backend/tests/api/routes/test_devices.py` (bulk-import per-row outcomes, read-time join), frontend component tests for hostname display, bulk-import, review panel, and infra-targets panel |
