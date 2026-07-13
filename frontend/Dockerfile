# Build context is the repo root (see compose.yml), matching backend/Dockerfile.

FROM node:24-alpine AS base
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Local/dev target: hot-reload Vite dev server, source bind-mounted in by
# compose.yml (this stage's own COPY below only matters if the image is run
# without that bind mount, e.g. `docker build` in isolation).
FROM base AS dev
COPY frontend/ ./
EXPOSE 5173
CMD ["npm", "run", "dev"]

# Production build stage
FROM base AS build
COPY frontend/ ./
RUN npm run build

# Production target: static files served by nginx, proxying /api to the
# backend service. nginx.conf.template is rendered to conf.d/default.conf
# at container startup by the base image's own envsubst-on-templates
# entrypoint hook -- BACKEND_UPSTREAM lets the same built image be deployed
# to every Compose/Swarm stack, each pointed at its own backend (see the
# template's own comment, and swarm/stack.*.yml for the Swarm override).
FROM nginx:alpine AS prod
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV BACKEND_UPSTREAM=backend
ENV NGINX_ENVSUBST_FILTER=^BACKEND_UPSTREAM$
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
