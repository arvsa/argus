# Frontend

React + TypeScript + Vite dashboard for Argus. Talks to the FastAPI backend
over REST (`/api/v1/*`) and a WebSocket (`/ws/pings`) for live device status.

See the [root README](../README.md) for how this fits into the full stack.

## Requirements

- Node.js (see `package.json` engines / your local toolchain)
- The backend running at `http://localhost:8000` (via Docker or
  `fastapi dev`) — the dev server proxies `/api` there

## Setup

```bash
cd frontend
npm install
```

## Development

```bash
npm run dev      # dev server at http://localhost:5173
```

`vite.config.ts` proxies `/api` (REST) and `/api/v1/ws` (WebSocket) to
`http://localhost:8000`, so the backend must be running separately — either
`docker compose watch backend` or `fastapi dev app/main.py` from `../backend`.

## Build

```bash
npm run build     # tsc -b && vite build
npm run preview   # preview the production build locally
```

## Tests

```bash
npm run test      # vitest run --passWithNoTests
```

Test setup and utilities live in `src/test/`.

## Lint

```bash
npm run lint      # oxlint
```

To enable type-aware lint rules, install `oxlint-tsgolint` and edit
`.oxlintrc.json` — see the
[Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules).

## Project layout

```
src/
  api/          REST client calls to the backend
  components/   shared UI components
  hooks/        custom React hooks
  layouts/      page layout shells
  pages/        route-level views
  store/        client state (zustand)
  lib/          utilities
  test/         vitest setup/helpers
```

Path alias `@` resolves to `src/` (configured in `vite.config.ts`).

## Known issue

`frontend/Dockerfile` does not exist yet, even though `compose.override.yml`
references one — `docker compose build` for the full stack will fail until
it's added. Run the frontend with `npm run dev` locally instead.
