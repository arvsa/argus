# Device Discovery (SNMP Infrastructure Polling)

## 1. Where this lives: pingsvc, not the backend

Same reasoning that already put ICMP in pingsvc instead of the backend
(`CLAUDE.md`'s architecture section): even though SNMP polling itself needs
no elevated capabilities, it's still network I/O directed at devices
*inside* a zone's local network -- a central `argus-server` has no route
to a zone's internal router/switch/WLC management IPs at all (zones are
typically NAT'd/firewalled and only ever push *outward*, per the existing
multi-zone architecture), so this has to run from wherever pingsvc already
runs, not centrally.

- **Maintainability** (the constraint the user raised): the backend is
  meant to be swappable independently (e.g. a future Rust rewrite). REST
  CRUD, auth, and a DB table are mechanical to port to any language/
  framework. SNMP MIB walking against a heterogeneous mix of vendor network
  gear is not -- keeping that logic in pingsvc means a backend rewrite
  never has to touch it. pingsvc's interface to the backend stays exactly
  what `plan/pingsvc-target-sync` (shipped) already established: pingsvc
  talks to the backend over HTTP with a shared token, nothing backend-
  language-specific leaks into pingsvc.
- **One SNMP subsystem, two purposes**: pingsvc already needs `gosnmp` for
  endpoint enrichment (sysName/sysDescr on already-known IPs, §2.1). Using
  the same library and worker-pool shape for infrastructure discovery
  (ARP/CAM-table walks) keeps all SNMP-handling code in one place instead
  of splitting it awkwardly between two services.
- **Reuses existing plumbing**: the `PINGSVC_SYNC_TOKEN`/
  `verify_pingsvc_token` machine-to-machine auth built for target-sync
  (`backend/app/api/deps.py`) is exactly the credential a new "pingsvc
  reports discovered devices" endpoint needs too -- no new auth mechanism
  required.

The backend's job stays what it already is: own the persisted device data,
expose it over the API, and gate the auto-populate-vs-review-queue policy.
pingsvc's job: discover, enrich, push what it found -- exactly the
`exporter.go` push model, not the target-sync pull model, since here
pingsvc is the source of truth about what it observed.

## 2. Design

### 2.1 Discovery mechanism: SNMP against network infrastructure

Poll the neighbor/ARP tables that already exist on a zone's own routers
and L3 switches, via SNMP -- the same technique real network-management/
CMDB tooling (SolarWinds, LibreNMS, NetBox's discovery plugins, etc.)
already uses for exactly this. This is a pull-based, credentialed
alternative to passive DHCP-packet snooping (an earlier draft's approach):
it sidesteps the broadcast-domain problem (a router's ARP table already
spans every VLAN it routes), needs no elevated capabilities beyond plain
UDP, and covers wireless and IPv6 clients as a side effect rather than
requiring workarounds for them.

- **Router/L3 switch ARP table**: `ipNetToPhysicalTable` (`IP-MIB`, RFC
  4293) -- a standard, vendor-neutral MIB table mapping IP to MAC to
  interface, and address-family agnostic (covers IPv6 NDP entries the same
  way it covers IPv4 ARP entries, so IPv6 needs no separate protocol path).
  One SNMP walk against a zone's core router already covers every VLAN
  that router routes between -- this is the core v1 mechanism.
- **Switch MAC-address/CAM table** (`dot1dTpFdbTable`, `BRIDGE-MIB`,
  standard): optional, low-cost addition giving (MAC, switch port) -- a
  real signal for suggesting Node placement later, not required for basic
  discovery. Cisco implements this per-VLAN (`community@vlan_id` indexing)
  rather than one flat walk -- handle per-vendor when implemented, not
  assumed universal.
- **Wireless controller client tables are out of v1 scope.** No standard
  MIB exists the way ARP/bridge tables have one -- each vendor (Cisco WLC,
  Aruba, ...) exposes its own, and some (Meraki) are cloud-API-only with no
  local SNMP at all. Cut for the same reason DHCP-server lease-file
  integration was cut (§4): too vendor-heterogeneous for a first pass.
  `discovered_via` (§2.2) reserves a `"wlc"` value for whenever this lands.
- **Optional lighter-weight bootstrap**: an active ARP sweep (ping every
  address in a subnet, then read back the *local* resolved neighbor table)
  needs no SNMP credentials at all -- useful as a fallback or a quick
  first-run bootstrap where infrastructure SNMP access isn't yet granted.

**SNMP enrichment** (unicast `sysName`/`sysDescr` GET against a known IP,
via [`gosnmp`](https://github.com/gosnmp/gosnmp)) is the same mechanism as
infrastructure discovery above, just pointed at endpoints instead of
routers/switches, to fill in/refine a hostname once an address is known.
Realistic expectations for what it actually yields, and the operational
dependencies it carries, are cataloged in §4 rather than repeated here.

- **Timezone is not a standard SNMP MIB-II value** -- flagged as an open
  question (§4), not designed here.

Both mechanisms are independently optional and off by default, same
"empty config = disabled" posture as every other pingsvc opt-in feature
(signing, S3 export, target-sync). Infrastructure polling additionally
requires the operator to explicitly configure which devices to poll
(§2.6) -- there's no discovery of the network's *own* infrastructure
devices in v1, a materially more predictable ask than the old design's
"expose a SPAN port."

### 2.2 Data model: a separate candidate pool, not the `Device` table directly

New table `DiscoveredDevice` (backend/app/models.py, parallel structure to
`Device`) rather than writing discoveries straight into `Device`:

- `id`, `addr` (unique), `mac: str | None`, `hostname: str | None`,
  `discovered_via: str` (`"arp"` / `"cam"` / `"wlc"` / `"snmp-enrich"` /
  `"arp-sweep"`, comma-separated or a small enum), `first_seen_at`,
  `last_seen_at`, `status: "pending" | "approved" | "rejected"`.
- **Why a separate table, not extending `Device` with a status field**:
  `GET /devices/targets-export` (and the new `targets-hash`/
  `targets-export-internal`, `backend/app/api/routes/devices.py`) already
  exports *every* `Device` row unconditionally -- an unreviewed candidate
  landing directly in `Device` would start getting pinged before an
  operator ever saw it. A separate table makes "not a monitored device
  yet" true by construction, with zero new filtering logic needed on the
  existing export path.
- **Upsert, not overwrite, keyed by `mac` (falling back to `addr` if MAC is
  unknown)**: "gradually build the database" means an ARP-table sighting
  followed later by an SNMP enrichment must merge, not clobber -- a report
  that doesn't carry a `hostname` must never null out a `hostname` an
  earlier report already established. `last_seen_at` always advances;
  every other field is `COALESCE(new, existing)` unless the new value is
  non-null.
- **Promotion**: approving a `DiscoveredDevice` (or auto-populate doing it
  immediately) creates/reassigns a real `Device` row via the exact same
  `crud.create_device`/orphan-reassignment logic `POST /devices/` already
  has (`backend/app/api/routes/devices.py:96-122`) -- discovery doesn't get
  its own parallel device-creation rules.
- `Device` itself also gains the enrichment fields so they survive
  promotion and show up in the UI: `hostname: str | None`, `mac: str |
  None`, `timezone: str | None` (all optional, freely editable post-
  creation like `addr`/`node_id` already are, `models.py:265-267`).

### 2.3 Device identity: `device_key` (MAC when known, else address)

An address moves between devices over time (a lease expires and the pool
reclaims it, a device is replaced, etc.) -- "the same logical device now
has a different address" is a real event this design has to survive
without losing continuity of history.

A universal switch to MAC-based identity doesn't work, though: **a MAC is
only ever knowable for a device on the same L2 broadcast domain as
whatever's watching it, or reachable via infrastructure that's tracking
it** (which is now the actual discovery mechanism, §2.1). A static-IP
device with no infrastructure polling covering it will never have a
knowable MAC through anything pingsvc does. That's fine, because those
devices don't have the churn problem either: a static IP is already
stable.

So identity is a computed value, not a fixed column: **`device_key` = `mac`
when a device has one on file, else `addr`** -- strictly generalizes today's
address-only identity rather than replacing it. For the (currently 100% of)
devices with no known MAC, `device_key == addr`, byte-for-byte what happens
today; nothing changes for static/undiscovered devices.

- The **backend** computes `device_key` per device (it already owns
  `Device`/`DiscoveredDevice`, so it already knows which devices have a
  confirmed MAC) and hands it to pingsvc through the same channel that
  already carries node assignment: the targets-export payload. The exact
  line-format extension (today: `addr,ancestor1;ancestor2;...;node_id`)
  needs a `device_key` field added without breaking the existing
  hand-editable bare-`addr` and `addr,ancestors` formats -- a real design
  decision to pin down during implementation (§4), not resolved here.
- **pingsvc stays a dumb executor**: it still pings whatever `addr` it's
  told (ICMP has no other option), but tags the Redis write with whatever
  `device_key` the backend assigned for that target -- it never computes
  mac-vs-addr identity logic itself.
- On an address change for a known device, target-sync (already shipped,
  `plan/pingsvc-target-sync`, 30s default poll) picks up the new `addr` for
  the same `device_key` on its next cycle and hot-swaps it in place -- no
  restart, no Redis discontinuity. There's a bounded window (up to one sync
  interval) where pingsvc is still hitting the stale address; that's an
  acceptable, self-healing gap.

### 2.4 Redis / ping-pipeline rekeying

The live-state layer (`pingsvc/cmd/pingsvc/main.go`) is entirely
address-keyed today and needs to move to `device_key` for the above to
actually take effect, with one deliberate exception:

- `state:device:<addr>` → `state:device:<device_key>`. The
  `publishIfChangedAndAggregateScript` Lua script's `KEYS[1]` becomes
  `device_key` instead of `addr`. The JSON event payload keeps `addr` (it's
  what's actually being pinged, and useful to show before a hostname is
  known) and adds `device_key` explicitly, so downstream consumers know how
  to join back to device metadata.
- **`stateCache`** (the in-memory "did this specific ping's result change"
  dedup, `main.go:275`) **stays keyed by `addr`, not `device_key`** -- it's
  about the mechanical act of pinging a specific address, not device
  identity, and doesn't need to change.
- `reconcileRemovedTargets` (`main.go:195-222`) operates on `device_key`
  too. This actually simplifies the "address changed" case: a MAC whose
  address changed is still a live `device_key` (its identity didn't
  disappear), so no cleanup fires for it at all -- only a genuinely removed
  device triggers the reconcile path. `pings:state`'s `addr` field for that
  `device_key` just gets naturally overwritten next time a ping result is
  written.
- `targetsByAddr` (`main.go:497-500`, already becoming `TargetStore` per
  the target-sync plan) needs a third field alongside `NodeIDs`:
  `DeviceKey`, populated from the new targets-export field.

Backward compatible by construction: since `device_key == addr` for every
device with no known MAC, this is a no-op for the entire fleet until
discovery actually confirms a MAC for something.

### 2.5 Staleness: poll-cycle-based, not lease-time-based

The original DHCP-snooping draft tried to compute an expected staleness
window from the DHCP lease time (Option 51) observed in a captured
DHCPACK, and flagged that passive capture would likely miss the unicast
renewal that would otherwise refresh it. **That whole problem goes away
under the SNMP-polling design**: there's no packet to miss, because
staleness is now just a function of the poll cycle itself.

- Each infrastructure poll cycle (§2.8) re-reads the current ARP/CAM
  tables from scratch and re-confirms (or updates) every `(mac, addr)`
  binding it finds -- `last_seen_at` advances on every cycle a binding is
  still observed, and updates `addr` immediately if a MAC now maps to a
  different address than last recorded.
- A binding is considered stale once it's been longer than
  `N × poll_interval` (a small multiple, not the interval itself, to
  tolerate one missed cycle) since it was last reconfirmed by any poll --
  surfaced in the UI, not silently trusted forever. No lease-time parsing,
  no DHCP-protocol-specific state at all.
- This is simpler and more reliably correct than the DHCP-snooping
  approach was, precisely because it's pull-based (ask the authoritative
  table directly, on a schedule you control) rather than passive (wait for
  traffic you might not see).

### 2.6 Backend: infra poll target configuration

Per-target SNMP credentials can't be a single global config value --
different infrastructure devices, especially across vendors or teams,
realistically have different community strings. Rather than push a list
of `(addr, community)` pairs through pingsvc-local env vars/flags (hard to
edit without touching pingsvc's own deployment, and awkward for an
operator already managing everything else -- zones, hierarchy, devices --
through the web UI), this is a new backend-owned table, managed the same
way as everything else:

- New table `InfraPollTarget` (`backend/app/models.py`): `id`, `addr`
  (unique), `community: str` (SNMP v2c community -- encryption note
  below), `kind: str` (`"router"` / `"switch"` -- hints whether to poll
  ARP-only or ARP+CAM; `"wlc"` reserved for whenever wireless-controller
  support lands, §2.1 -- not implemented in v1), `enabled: bool = True`,
  `created_at`.
- CRUD routes (superuser-gated, human JWT, ordinary admin workflow):
  `GET`/`POST /discovery/infra-targets`, `PATCH`/`DELETE
  /discovery/infra-targets/{id}` -- a small settings page
  (`plan/device-naming-and-bulk-import-v1.md` §2.4), not a pingsvc-facing
  route.
- **Never echo the community string back once set** -- same write-only
  pattern already designed for the encryption key in
  `plan/optional-snapshot-encryption-v1.md` (`GET .../encryption-key`
  returns only `{"registered": true, ...}`, never the secret itself).
  `GET /discovery/infra-targets` returns `{addr, kind, enabled,
  community_set: true}` to the UI, never the plaintext.
- **Encryption at rest is a real requirement, not yet designed** -- a
  community string is a real (if weak) credential, and this is the first
  case of a *third-party device* credential (not the backend's own
  identity secret) living in this database. Same open item already
  flagged in the encryption plan for `ZoneEncryptionKey`'s key material:
  needs its own review (`SECRET_KEY`-derived envelope encryption, or a KMS
  integration) before this ships, not designed here.
- **pingsvc-facing pull route**: `GET /discovery/infra-targets-internal`
  (gated by the existing `verify_pingsvc_token`, same dependency
  target-sync already uses) returns the *decrypted*, pingsvc-usable list --
  pingsvc has to have the real community string to actually query a device
  with it, so this is necessarily plaintext over the already-authenticated
  channel, same trust boundary as `targets-export-internal`. No
  hash-then-fetch optimization needed here (unlike target-sync's device/
  node export) -- this list is small (a handful of infrastructure devices,
  typically) and changes rarely, so pingsvc just re-fetches it in full on
  every discovery cycle.
- **This reuses the connection pingsvc already has, not a new one**:
  pingsvc already talks to the backend over `ARGUS_BACKEND_URL` +
  `ARGUS_PINGSVC_SYNC_TOKEN` for target-sync -- the infra-target pull is
  just another endpoint on that same already-configured channel. Discovery
  needs no new pingsvc-side connection config at all (§2.8).

### 2.7 Backend: ingestion + review/auto-populate

- `POST /devices/discovered` (new route in `devices.py`), gated by
  `verify_pingsvc_token` (same dependency as target-sync's routes) --
  accepts a batch (pingsvc reports in batches, same shape as the exporter's
  periodic snapshot push) of `{addr, mac, hostname, discovered_via}`,
  applies the merge-upsert rule above. If `settings.AUTO_POPULATE_DISCOVERED_DEVICES`
  is true, each upserted row is immediately promoted to a real `Device` in
  the same request; otherwise it just sits in the candidate pool.
- `GET /devices/discovered` / `POST /devices/discovered/{id}/approve` /
  `POST /devices/discovered/{id}/reject` (superuser-gated, human JWT --
  this is an operator review workflow, not a pingsvc-facing route) for the
  manual-review path.
- New setting `AUTO_POPULATE_DISCOVERED_DEVICES: bool = False`
  (`backend/app/core/config.py`) -- the literal on/off toggle the user
  described. Off by default: discovery should never silently start
  monitoring something an operator hasn't seen, until they opt in.

### 2.8 pingsvc: discovery subsystem

New files, mirroring `exporter.go`'s established shape (`runExporter`'s
child-context/done-channel/ticker/stop-func pattern, per-cycle work
factored into its own testable function):

- `discovery.go` -- `runDiscovery(ctx, cfg) func()`, each cycle: pulls the
  current infra-target list from `GET /discovery/infra-targets-internal`
  (§2.6), polls each via `snmp_infra.go`, runs `snmp_enrich.go` against
  whatever IPs are now known, and pushes accumulated results via `POST
  /devices/discovered` -- same auth header pattern `targetsync.go` already
  established for the reverse direction, over the connection pingsvc
  already has (`ARGUS_BACKEND_URL`/`ARGUS_PINGSVC_SYNC_TOKEN`, both
  existing target-sync settings -- no new connection config).
- `snmp_infra.go` -- `gosnmp`-based polling of the pulled infrastructure
  targets: walks `ipNetToPhysicalTable` (ARP/NDP) and, where `kind`
  indicates it, `dot1dTpFdbTable` (CAM, with the per-vendor VLAN-indexing
  handling noted in §2.1). Writes results into an in-memory pending-batch
  buffer (mutex- or channel-guarded, independent of the ping pipeline's
  own channels -- same isolation rationale as the exporter, a slow poll
  must never backpressure ping workers).
- `snmp_enrich.go` -- `gosnmp`-based endpoint enrichment: given a set of
  known IPs (from `snmp_infra.go`'s buffer plus, optionally, already-known
  `Device`/`DiscoveredDevice` addresses fetched from the backend), `SNMP
  GET` `sysName`/`sysDescr` on a slower independent ticker (unicast
  per-target, not broadcast -- closer in shape to the ICMP worker pool than
  to a table walk, but at a much lower target-count/frequency, so a small
  dedicated pool rather than reusing the ping pipeline's).
- `arpsweep.go` (optional, §2.1's lighter-weight bootstrap) -- pings every
  address in a configured local subnet, then reads back the OS's own
  resolved neighbor table for that subnet. No SNMP credentials needed;
  useful as a fallback where infrastructure SNMP access isn't available.
- **The only new pingsvc-side config is the cycle interval**:
  `-discovery-interval`/`ARGUS_DISCOVERY_INTERVAL_SECONDS` (default 60s --
  less urgent than target-sync's 30s default, discovery isn't affecting
  live ping targets). No target list, no community string, no separate
  enable/disable flag on pingsvc's side at all -- discovery is naturally a
  no-op whenever the backend has zero `InfraPollTarget` rows configured
  (§2.6), and otherwise reuses target-sync's existing `ARGUS_BACKEND_URL`
  to know discovery is even possible. Gated by `role.RunsPingPipeline()`
  like target-sync, started/stopped in `main()` alongside it.

### 2.9 Mock network for development/testing

Two independent code paths need mocking, and they need genuinely different
kinds of fixture -- one is a protocol-response mock, the other needs a real
(if virtual) L2 broadcast domain:

- **SNMP infra polling (`snmp_infra.go`/`snmp_enrich.go`) needs no real ARP
  or L2 topology at all** -- it's just "answer these specific SNMP GET/WALK
  requests with canned data," decoupled entirely from whatever the
  responding container's actual network state is. Use
  [`snmpsim`](https://github.com/etingof/snmpsim) (a maintained Python tool
  built exactly for this, serving from plain `.snmprec` fixture files -- one
  `OID, type, value` per line, trivial to hand-author) rather than
  configuring real `snmpd`'s static-OID mechanism or writing a custom stub.
  One `snmpsim` container answers `ipNetToPhysicalTable`/`dot1dTpFdbTable`
  walks with a handful of fixed (IP, MAC, ifIndex) tuples for
  `snmp_infra.go`; the same or a second instance serves fixed
  `sysName`/`sysDescr` values for `snmp_enrich.go`. Neither needs any
  pingable containers behind it -- the MIB data is pure fixture.
- **Active ARP sweep (`arpsweep.go`) does need a real L2 domain** -- it
  works by pinging addresses and reading back the *pinging host's own
  kernel ARP cache*, so there's no protocol response to fake; the OS
  genuinely has to resolve ARP. Docker's bridge driver is a real Linux
  bridge under the hood (veth pairs into it), so containers on the same
  custom bridge network are truly L2-adjacent -- a handful of cheap
  `alpine`/`busybox` containers that do nothing but answer ICMP, on a
  fixed-subnet bridge network alongside pingsvc-under-test (already has
  `NET_RAW`/`NET_ADMIN`), give `arpsweep.go` a genuine (if virtual)
  neighbor table to read back with zero simulation needed.
- This is dev/test-only infrastructure -- a new `swarm/stack.mock-lan.yml`
  (a custom bridge network on a fixed subnet for deterministic fixture
  IPs, the ICMP-only device containers, one or two `snmpsim` containers,
  pingsvc-under-test) or a `compose.override.yml` profile, not part of any
  production topology.

## 3. Phased Rollout (TDD, per CLAUDE.md)

Given the size, this is multiple branches/PRs, each independently
reviewable -- not one big change. The `device_key` rekeying goes *first*,
ahead of discovery itself, since it's backward-compatible by construction
(§2.3/§2.4 -- a no-op for every device with no known MAC) and everything
downstream depends on it existing:

1. **`feature/device-key-rekeying`** -- `device_key` computed field on the
   backend, targets-export format extension (§2.3), pingsvc's
   `TargetStore`/`main.go` rekeyed from `addr` to `device_key` for
   `state:device:*` and the Lua script's `KEYS[1]` (§2.4), `stateCache`
   deliberately left addr-keyed. RED: a target with no MAC behaves
   byte-identical to today (regression-proof the common case first); a
   target with a MAC populates `state:device:<mac>`, not `<addr>`; an
   address change for a known `device_key` doesn't trigger
   `reconcileRemovedTargets`.
2. **`feature/device-discovery-schema`** -- `DiscoveredDevice` table +
   migration, `Device` gains `hostname`/`mac`/`timezone`, backend CRUD +
   `POST /devices/discovered` (behind `verify_pingsvc_token`) +
   approve/reject routes + `AUTO_POPULATE_DISCOVERED_DEVICES` setting.
   RED: upsert-merges-not-overwrites test, auto-populate-promotes-
   immediately test, manual-review-stays-pending test, targets-export
   never includes a pending candidate.
3. **`feature/discovery-infra-target-config`** -- `InfraPollTarget` table +
   migration (§2.6), admin CRUD routes, `GET
   /discovery/infra-targets-internal` (behind `verify_pingsvc_token`).
   RED: `GET /discovery/infra-targets` never returns a set community
   string in its response body; the pingsvc-facing route does; CRUD is
   superuser-gated. Community-string encryption-at-rest is a named
   prerequisite for this step, not solved by it (§4).
4. **`feature/pingsvc-snmp-enrichment`** -- `snmp_enrich.go` + wiring,
   against the mock `snmpd` container. RED: given a set of IPs and a
   fake/mock SNMP responder, enrichment produces the right hostname; given
   no response, times out cleanly without blocking the cycle.
5. **`feature/pingsvc-infra-discovery`** -- `snmp_infra.go` (ARP table
   polling, CAM table where configured -- WLC deferred per §2.1) +
   `arpsweep.go` + the mock-SNMP-agent test infra (§2.9) + `discovery.go`'s
   pull-from-step-3/push-to-step-2 cycle, including poll-cycle-based
   staleness (§2.5). RED: given a mock agent's fixture ARP-table response,
   the right MAC/IP pairs are extracted and pushed; given no response from
   a configured infra target, the cycle logs and continues rather than
   blocking; a binding not reconfirmed for `N × poll_interval` is marked
   stale.

Each branch: RED → implement → GREEN (`./scripts/test.sh`, `go test ./...`)
→ show diff → wait for approval → commit → push → PR, same cadence as
every other change this session.

Hostname display, the discovered-devices review UI, the infra-targets
settings UI, manual name entry, and CSV bulk import are all covered by the
companion plan, `plan/device-naming-and-bulk-import-v1.md` -- its UI-facing
steps (review panel, infra-targets panel) depend on steps 2 and 3 above
having shipped; its other steps (hostname display, manual entry, bulk
import) don't depend on anything in this plan at all and can ship in any
order, including before this plan starts.

## 4. Open Questions / Risks

- **Exact `device_key` wire format in targets-export** (§2.3) needs to be
  pinned down without breaking the existing hand-editable bare-`addr` and
  `addr,ancestors` formats -- not resolved in this doc.
- **Timezone has no standard SNMP source.** Needs a decision before step 2
  locks the schema: operator-set free text, inferred from a vendor MIB per
  device class (extra scope), or dropped from v1 and revisited later.
- **Operator has to already know their infrastructure device addresses.**
  Unlike the old DHCP-snooping design (which needed a network tap but no
  device inventory), this design needs the operator to explicitly list
  which routers/switches/WLCs to poll (§2.7) -- there's no "discover the
  network's own infrastructure" step in v1. More predictable to set up
  than a SPAN port, but it is an upfront onboarding step, not zero-config.
- **SNMP access to core infrastructure is its own coordination step**,
  arguably a bigger organizational ask than endpoint SNMP was -- network
  teams are often more cautious about granting read access to core
  routers/switches than to edge devices, even though it's GET-only.
- **Vendor heterogeneity for the CAM table**: `dot1dTpFdbTable` needs
  per-vendor VLAN-indexing handling (Cisco's `community@vlan`), not a
  single flat walk universally.
- **Wireless client discovery is deferred entirely, not v1 scope** (§2.1):
  no standard MIB exists the way ARP/bridge tables have one, each vendor
  (Cisco WLC, Aruba, ...) exposes its own, and some (Meraki) are
  cloud-API-only with no local SNMP at all. Whenever this is picked up, it
  should target one or two vendors deliberately, not "wireless" generally.
- **SNMP community strings are a weak credential** (v2c default `"public"`
  is famously often left unchanged on real devices) -- v1 targets v2c for
  simplicity per §2.1. SNMPv3 (real auth) is a reasonable future
  enhancement, not v1 scope.
- **SNMP enrichment's realistic yield is low for most endpoints, and it
  carries real operational dependencies -- own this rather than implying
  it generally works**: `sysDescr` is usually populated but free-text/
  vendor-specific; `sysName` is optional and often blank. Switches/
  routers/printers: generally good if SNMP is enabled. Laptops/phones/IoT/
  controller-managed APs: poor to none -- most of a typical enterprise's
  endpoint population will end up identified by address only. Devices
  (and especially *core* infrastructure) may ACL SNMP to specific manager
  IPs or disable it outright, requiring pingsvc's host to be explicitly
  allow-listed by whoever owns the network -- an organizational
  coordination step, not a toggle. Polling many hosts on UDP/161 in a
  short window can visually resemble a scan to an IDS/IPS/NAC system.
  Cloud-managed fleets (Meraki, Cisco DNA-managed switches) often have no
  locally-pollable agent at all -- out of reach for this mechanism
  entirely. At scale, default multi-second timeouts summed across
  thousands of unreachable/filtered targets can dominate a poll cycle --
  needs a short timeout (1-2s), low retry count (0-1), and bounded
  concurrency (§2.8), not the library's defaults.
- **ARP/CAM table entries age out too, just on a different schedule than
  DHCP leases did** -- routers/switches expire idle neighbor entries on
  their own timers (typically longer than an end-host's ARP cache, but not
  infinite), so a device that hasn't communicated recently may briefly
  disappear from what's pollable even though it's still on the network.
  Poll-cycle-based staleness (§2.5) already accounts for "not seen this
  cycle," but a real gap between "not currently in the table" and "gone"
  is inherent to this technique too.
- **802.1X/NAC interaction**: on port-authenticated networks a device may
  not reach a usable connection (and so may not appear in any ARP/CAM
  table at all) until it authenticates, or may briefly land in a
  quarantine/guest VLAN before being moved to production post-auth,
  appearing twice under two addresses in quick succession. Common enough
  in higher-security enterprise deployments to be worth a note, not
  designed around here.
- **Push batch size / backend load**: a large infrastructure poll (a big
  router's full ARP table) could produce a large batch in one push.
  `POST /devices/discovered` should cap/paginate rather than assume an
  unbounded batch -- worth confirming during step 2's implementation, not
  fully specified here.

## 5. Key File Touch Points

| Area | Files |
|---|---|
| Model/migration | `backend/app/models.py` (new `DiscoveredDevice*` and `InfraPollTarget*`, §2.6, `Device` gains `hostname`/`mac`/`timezone`), new Alembic revisions |
| Config | `backend/app/core/config.py` (`AUTO_POPULATE_DISCOVERED_DEVICES`) |
| CRUD/routes | `backend/app/crud.py`, `backend/app/api/routes/devices.py` (`POST /devices/discovered`, approve/reject, `device_key` in targets-export, gated by existing `verify_pingsvc_token`), new `backend/app/api/routes/discovery.py` (`InfraPollTarget` CRUD + `infra-targets-internal`, §2.6) |
| pingsvc -- rekeying | `pingsvc/cmd/pingsvc/main.go` (`TargetStore`/`targetsByAddr` gains `DeviceKey`, Lua `KEYS[1]`, `reconcileRemovedTargets`, `stateCache` deliberately unchanged) |
| pingsvc -- discovery | `discovery.go` (new), `snmp_infra.go` (new), `snmp_enrich.go` (new), `arpsweep.go` (new), `main.go` (flags + start/stop wiring), `go.mod` (+gosnmp) |
| Dev/test infra | New Compose mock-SNMP-agent service(s) (fixture ARP/CAM table responses, `sysName`/`sysDescr`) |
| Tests | `backend/tests/api/routes/test_devices.py`, `backend/tests/api/routes/test_discovery.py` (`InfraPollTarget` CRUD, community-string never echoed), `pingsvc/cmd/pingsvc/discovery_test.go`/`snmp_infra_test.go`/`snmp_enrich_test.go`/`arpsweep_test.go`/`main_test.go` (rekeying) |

Frontend and additional test files (hostname display, review/infra-targets
panels, bulk import) are tracked in
`plan/device-naming-and-bulk-import-v1.md` §5, not here.
