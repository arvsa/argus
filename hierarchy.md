# Setting Up a Hierarchy and Assigning Devices

This walks through the full loop for organizing your monitored devices into
an asset hierarchy (e.g. `Region → Site → Rack` or `Campus → Building →
Room`) and telling pingsvc which physical place each device lives in, end
to end. See [CLAUDE.md](CLAUDE.md)'s architecture section and
[plan/dynamic-hierarchy-multi-zone-architecture.md](plan/dynamic-hierarchy-multi-zone-architecture.md)
for the underlying data model design.

## 1. Define the hierarchy *shape*

The shape is the rank chain itself (e.g. "a Region contains Sites, a Site
contains Racks") -- not the actual Regions/Sites/Racks you'll create later.
Two ways to set it up, pick one:

**Option A -- `hierarchy.yaml` (bulk, one-shot, good for a fresh zone):**

```bash
cp hierarchy.yaml.example hierarchy.yaml
# edit tenant_id and levels to match your organization
docker compose up -d --force-recreate prestart   # re-runs seeding
```

This is read once per prestart (container start/restart) by
`backend/app/seed_hierarchy.py`. It's idempotent -- re-running with the same
file is a no-op -- but **fails loudly** (doesn't start) if you rename or
remove a rank that already has real Nodes under it; that kind of structural
change needs an explicit migration, not an unattended file edit.

**Option B -- the frontend, one level at a time (good for incremental
changes):** log in, go to **Hierarchy → Hierarchy Types** (superuser only),
and use "Create root level" / "Add level" to build the chain up. You can
rename any level, but can only delete the *last* (deepest) one -- deleting
a middle level would cascade-delete everything below it.

Either way, you end up with the same thing: a `NodeType` chain visible on
the **Hierarchy Types** page.

## 2. Create the actual Node instances

Go to **Hierarchy** (the main tree page). Click "Add root node" to create
your first top-level instance (e.g. a specific Region), then expand it and
"Add child" to build out Sites, Racks, etc. underneath. Rename/delete work
the same way as NodeTypes -- delete cascades to everything below the
deleted node.

## 3. Assign devices to Nodes

Select a Node in the tree -- its detail panel (right side) has an
**"Assigned devices"** section. Click **Add**, enter the device's address
(IP or hostname), and it's recorded against that Node. Remove a device the
same way, via the trash icon + confirm.

This is a real, persisted record (`Device` in the backend, `addr` +
`node_id`) -- distinct from the separate `/devices` page, which shows
*live ping status* from Redis, not hierarchy assignment.

## 4. Push the assignment to pingsvc

pingsvc reads a flat file (`pingsvc/targets.txt`), not the database
directly, and **has no hot-reload** -- so getting your assignments into it
is a deliberate regenerate + restart step:

```bash
bash scripts/regenerate-targets.sh
```

This calls `GET /api/v1/devices/targets-export` (superuser-only), which
turns every `Device` row into exactly the line format pingsvc expects --
`addr,ancestor1;ancestor2;...` for an assigned device (root-first
ancestors, then the Node itself last) or a bare `addr` for an unassigned
one -- writes it to `pingsvc/targets.txt`, and restarts the `pingsvc`
container so it picks up the new file.

## 5. Verify

Back in the **Hierarchy** tree, each node shows a live "X up / Y down"
badge (`NodeStatusBadge`) sourced from pingsvc's per-node Redis counters.
Once pingsvc has pinged your newly-assigned device at least once, the
Node you assigned it to should reflect that in its badge -- confirming the
whole chain (hierarchy shape → Node → Device → targets.txt → pingsvc →
Redis → frontend) actually works end to end.

## Known limitation

There's no live sync between the `Device` table and `pingsvc/targets.txt`
-- every assignment change requires re-running
`scripts/regenerate-targets.sh` (which restarts pingsvc, briefly
interrupting its ping pipeline). A real file-watch or signal-driven reload
in pingsvc would remove this step; it's a natural follow-up, not built yet.
