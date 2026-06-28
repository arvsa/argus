# Frontend Dashboard Plan — Argus v1

## Goal

A browser-based dashboard for monitoring network devices in real time and managing the Campus → Building → Room → Device hierarchy. Targets two roles: regular users (read-only monitoring) and superusers (full CRUD + user management).

---

## Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| Framework | React 19 + TypeScript | Industry standard, excellent ecosystem |
| Build tool | Vite | Fast HMR, minimal config |
| Routing | React Router v7 | File-based or config routing, nested layouts |
| Data fetching | TanStack Query v5 | Cache, background refetch, optimistic updates |
| Styling | Tailwind CSS v4 | Utility-first, pairs well with shadcn |
| Component library | shadcn/ui | Accessible, unstyled-first, copy-owned components |
| Forms | React Hook Form + Zod | Validation schema mirrors backend Pydantic models |
| WebSocket | Native browser WebSocket + custom hook | No extra library needed |
| HTTP client | Axios | Interceptors for JWT injection and 401 handling |
| CSV export | papaparse | Already familiar for the upload side too |
| State (auth) | Zustand | Lightweight global store for JWT + current user |

---

## API Endpoint Map

### Auth
| Method | Path | Used by |
|---|---|---|
| POST | `/api/v1/login/access-token` | Login page |
| POST | `/api/v1/users/signup` | Register page |
| POST | `/api/v1/password-recovery/{email}` | Forgot password |
| POST | `/api/v1/reset-password/` | Reset password |

### Users (superuser only for list/manage)
| Method | Path | Used by |
|---|---|---|
| GET | `/api/v1/users/me` | Profile page, nav header |
| PATCH | `/api/v1/users/me` | Profile edit |
| PATCH | `/api/v1/users/me/password` | Change password |
| GET | `/api/v1/users/` | Admin → Users list |
| POST | `/api/v1/users/` | Admin → Create user |
| PATCH | `/api/v1/users/{id}` | Admin → Edit user |
| DELETE | `/api/v1/users/{id}` | Admin → Delete user |

### Hierarchy CRUD
| Resource | List | Get | Create | Update | Delete |
|---|---|---|---|---|---|
| Campuses | GET `/campuses/` | GET `/campuses/{id}` | POST `/campuses/` | PUT `/campuses/{id}` | DELETE `/campuses/{id}` |
| Buildings | GET `/buildings/` | GET `/buildings/{id}` | POST `/buildings/` | PUT `/buildings/{id}` | DELETE `/buildings/{id}` |
| Rooms | GET `/rooms/` | GET `/rooms/{id}` | POST `/rooms/` | PUT `/rooms/{id}` | DELETE `/rooms/{id}` |
| Devices | GET `/devices/` | GET `/devices/{id}` | POST `/devices/` | PUT `/devices/{id}` | DELETE `/devices/{id}` |

### Real-time & State
| Method | Path | Used by |
|---|---|---|
| WS | `/ws/pings` | Live status feed, status badges throughout |
| GET | `/api/v1/state` | Full device state table (paginated) |
| GET | `/api/v1/state_scan` | Scroll-to-load alternative |
| GET | `/api/v1/rooms/{id}/states` | Room detail → per-device status |

### Bulk Operations
| Method | Path | Used by |
|---|---|---|
| POST | `/api/v1/devices/upload` | Devices → Bulk import page |

---

## Pages & Routes

```
/                         → redirect to /dashboard
/login                    → Login
/register                 → Sign up
/forgot-password          → Password recovery
/reset-password           → Reset (token from email)

/dashboard                → Live overview (global up/down stats)
/campuses                 → Campus list
/campuses/:id             → Campus detail + buildings within
/buildings/:id            → Building detail + rooms within
/rooms/:id                → Room detail + device states
/devices                  → Full device table + CSV upload
/devices/:id              → Device detail

/admin/users              → User list + approve/reject (superuser)
/admin/users/:id          → User edit

/profile                  → Current user profile + password change
```

---

## Layout & Navigation

```
┌──────────────────────────────────────────────────────┐
│  Sidebar (collapsible)     │  Main content area       │
│                            │                          │
│  [Argus logo]              │  <page content>          │
│                            │                          │
│  Dashboard                 │                          │
│  Campuses                  │                          │
│    └ Buildings             │                          │
│        └ Rooms             │                          │
│  Devices                   │                          │
│  ──────────────            │                          │
│  Admin (superuser)         │                          │
│    Users                   │                          │
│  ──────────────            │                          │
│  Profile                   │                          │
│  Logout                    │                          │
└──────────────────────────────────────────────────────┘
```

A top bar shows:
- Live WebSocket connection status badge (connected / reconnecting / disconnected)
- Global up/down device count (updated via WS events)
- User avatar + quick profile menu

---

## Page Designs

### Dashboard (`/dashboard`)

- **Summary cards**: Total devices, devices UP (green), devices DOWN (red), % uptime
- **Live event feed**: scrolling list of state-change events from `/ws/pings`, newest on top, max 200 entries
- **Down device list**: table of currently DOWN devices, auto-updated by WS events
- Polling fallback: if WS disconnects, refetch `/api/v1/state` every 30 s

### Campus List (`/campuses`)

- Table with columns: Name, # Buildings, Created — all sortable
- "New Campus" button (superuser only) → inline slide-over form
- Row click → navigate to `/campuses/:id`

### Campus Detail (`/campuses/:id`)

- Header: campus name, edit/delete actions (superuser)
- Buildings grid/table within campus, each card showing building name + up/down ratio
- "Add Building" (superuser)

### Building Detail (`/buildings/:id`)

- Header: building name, campus breadcrumb, edit/delete (superuser)
- Rooms grid, each card: room name + live up/down badge (colour from WS channel `events:bldg:<id>`)
- "Add Room" (superuser)

### Room Detail (`/rooms/:id`)

- Header: room name, building breadcrumb, edit/delete (superuser)
- Device table: IP, hostname, last seen, status badge (UP/DOWN/UNKNOWN)
- Data sourced from `GET /rooms/{id}/states` (initial load) then updated via WS `events:room:<id>` channel
- Export button → download visible rows as CSV

### Device Table (`/devices`)

- Server-side paginated table using `GET /api/v1/state` (ordered by recency)
- Columns: IP, room, building, campus, status, last seen
- Search/filter by status (up/down), campus, building
- **Bulk import** panel (superuser): drag-and-drop CSV upload → calls `POST /devices/upload?dry_run=true` first to preview errors, then confirms to commit
- Export: download current filtered view as CSV

### Device Detail (`/devices/:id`)

- IP, hostname, room assignment, status badge
- Inline edit form (superuser)

### Admin → Users (`/admin/users`)

- User table: email, role (superuser badge), admission_status, created
- Approve / Reject buttons for `pending` users (PATCH `admission_status`)
- Create user button → modal form
- Delete user with confirmation dialog

### Profile (`/profile`)

- Display email, name fields — editable via PATCH `/users/me`
- Separate "Change Password" section

---

## Key Components

| Component | Description |
|---|---|
| `StatusBadge` | Green/red/grey pill for UP / DOWN / UNKNOWN |
| `LiveFeed` | Auto-scrolling event list driven by WS messages |
| `HierarchyBreadcrumb` | Campus › Building › Room trail |
| `DataTable` | Reusable sortable/paginated table (wraps shadcn Table) |
| `SlideOver` | Right-panel form overlay for create/edit |
| `ConfirmDialog` | Delete confirmation modal |
| `CsvUploader` | Drag-drop zone + dry-run preview table |
| `StatCard` | Summary metric card (count + trend) |
| `WsIndicator` | Top-bar connection status dot |

---

## WebSocket Strategy

Single shared WebSocket connection managed at app root via a custom `useWebSocket` hook.

```
connect to /ws/pings on mount
  on message → parse JSON → dispatch to zustand ws-events store
  on disconnect → exponential back-off reconnect (1 s → 2 s → 4 s → max 30 s)
  on reconnect → refetch /api/v1/state to patch any missed events
```

Components subscribe to the WS store via selectors — no prop drilling.

Event shape expected from backend (from pingsvc Lua script):
```json
{ "addr": "10.0.1.5", "state": "up|down", "ts": 1234567890, "room_id": "...", "bldg_id": "..." }
```

---

## Auth Flow

1. `POST /login/access-token` → store JWT in memory (Zustand) + `httpOnly` cookie if backend supports, else localStorage as fallback
2. Axios request interceptor attaches `Authorization: Bearer <token>` to every request
3. Axios response interceptor catches 401 → clear store → redirect to `/login`
4. Protected routes: `<RequireAuth>` wrapper component checks Zustand store
5. Superuser-only routes: `<RequireSuperuser>` renders 403 page for regular users

---

## Data Export

Two export scenarios:

**Current view export (client-side)**
- User clicks "Export CSV" on any table
- `papaparse.unparse()` converts the in-memory query cache data to CSV
- Triggers `<a download>` — no backend roundtrip

**Full export (device state)**
- Calls `GET /api/v1/state` with `size=1000`, loops pages until `total` exhausted
- Streams rows into CSV via papaparse and triggers download
- Progress modal shows page X / N during multi-page fetch

---

## Implementation Phases

### Phase 1 — Foundation
- Vite + React + TypeScript scaffold in `frontend/`
- Tailwind + shadcn setup
- Axios instance with interceptors
- Zustand auth store
- React Router layout: public routes (login/register) and private shell
- Login, Register, Forgot Password, Reset Password pages

### Phase 2 — Monitoring Core
- `useWebSocket` hook + WS event store
- Dashboard page: stat cards + live feed + down-device list
- Room detail page with per-device status (uses `/rooms/:id/states` + WS)
- `StatusBadge`, `LiveFeed`, `WsIndicator` components

### Phase 3 — Hierarchy CRUD
- Campuses list + detail
- Buildings detail
- Rooms list
- Devices table (paginated via `/state`)
- `DataTable`, `SlideOver`, `ConfirmDialog` components
- Superuser create/edit/delete for all resources

### Phase 4 — Bulk & Export
- CSV upload flow with dry-run preview (`/devices/upload`)
- Client-side export for any table
- Full-state export with pagination loop

### Phase 5 — Admin & Polish
- Admin → Users page (list, approve/reject, create, delete)
- Profile page
- Responsive sidebar (mobile hamburger)
- Error boundaries + empty states + skeleton loaders
- Keyboard navigation / accessibility pass

---

## File Structure

```
frontend/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
└── src/
    ├── main.tsx
    ├── App.tsx                  # router root
    ├── api/
    │   ├── client.ts            # axios instance
    │   ├── auth.ts
    │   ├── campuses.ts
    │   ├── buildings.ts
    │   ├── rooms.ts
    │   ├── devices.ts
    │   ├── users.ts
    │   └── pings.ts
    ├── store/
    │   ├── auth.ts              # zustand auth slice
    │   └── ws.ts                # zustand ws-events slice
    ├── hooks/
    │   ├── useWebSocket.ts
    │   └── useExport.ts
    ├── components/
    │   ├── ui/                  # shadcn generated components
    │   ├── StatusBadge.tsx
    │   ├── LiveFeed.tsx
    │   ├── DataTable.tsx
    │   ├── SlideOver.tsx
    │   ├── ConfirmDialog.tsx
    │   ├── CsvUploader.tsx
    │   ├── StatCard.tsx
    │   ├── WsIndicator.tsx
    │   └── HierarchyBreadcrumb.tsx
    ├── layouts/
    │   ├── AppShell.tsx         # sidebar + top bar
    │   └── AuthLayout.tsx       # centered card for login etc.
    ├── pages/
    │   ├── Login.tsx
    │   ├── Register.tsx
    │   ├── ForgotPassword.tsx
    │   ├── ResetPassword.tsx
    │   ├── Dashboard.tsx
    │   ├── Campuses.tsx
    │   ├── CampusDetail.tsx
    │   ├── BuildingDetail.tsx
    │   ├── RoomDetail.tsx
    │   ├── Devices.tsx
    │   ├── DeviceDetail.tsx
    │   ├── Profile.tsx
    │   └── admin/
    │       └── Users.tsx
    └── lib/
        ├── utils.ts             # cn(), date helpers
        └── schemas.ts           # Zod schemas mirroring backend models
```

---

## Development Setup

The frontend dev server proxies API calls to the backend so CORS is never an issue locally:

```ts
// vite.config.ts
server: {
  proxy: {
    '/api': 'http://localhost:8000',
    '/ws':  { target: 'ws://localhost:8000', ws: true },
  }
}
```

Docker: add a `frontend` service to `docker-compose.yml` that mounts `frontend/` and runs `npm run dev`, or serve the Vite build via the existing nginx / FastAPI static mount.

---

## Notes

- All superuser-only actions (create/edit/delete campuses, buildings, rooms, devices; user management) must be hidden from the UI when `current_user.is_superuser === false` — not just disabled.
- The `admission_status` field (`pending` / `approved` / `rejected`) on users implies an approval flow; the Admin → Users page should prominently surface `pending` users.
- The `/state` endpoint is ordered by recency (Redis sorted set); prefer it over `/state_scan` for the main device table since scan ordering is non-deterministic.
- Device bulk upload replaces the entire devices table — make the UI warn the user clearly before committing (dry-run first, then a destructive-action confirmation).
