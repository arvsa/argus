# Argus - Deployment

You can deploy Argus using Docker Compose to a remote server — as a single stack, or as one or more `argus-client` zones plus a central `argus-server` (see [Multi-zone configuration](#multi-zone-configuration)).

This project expects you to have a Traefik proxy handling communication to the outside world and HTTPS certificates.

You can use CI/CD (continuous integration and continuous deployment) systems to deploy automatically, there are already configurations to do it with GitHub Actions.

But you have to configure a couple things first.

## Preparation

* Have a remote server ready and available.
* Configure the DNS records of your domain to point to the IP of the server you just created.
* Configure a wildcard subdomain for your domain, so that you can have multiple subdomains for different services, e.g. `*.argus.example.com`. This will be useful for accessing different components, like `api.argus.example.com`, `traefik.argus.example.com`, etc. And also for `staging`, like `api.staging.argus.example.com`, etc.
* Install and configure [Docker](https://docs.docker.com/engine/install/) on the remote server (Docker Engine, not Docker Desktop).

## Public Traefik

A single Traefik proxy handles incoming HTTP(S) and certificates for every stack on the box (one or more, each with its own domain). Set up once per server:

```bash
# from your local machine: copy the Traefik compose file to the server
mkdir -p /root/code/traefik-public/   # (on the server)
rsync -a compose.traefik.yml root@your-server.example.com:/root/code/traefik-public/

# on the server: the shared network every stack's containers join
docker network create traefik-public
```

`compose.traefik.yml` reads these from the environment at startup:

```bash
export USERNAME=admin
export PASSWORD=changethis
export HASHED_PASSWORD=$(openssl passwd -apr1 $PASSWORD)   # for HTTP Basic Auth on the Traefik dashboard
export DOMAIN=argus.example.com
export EMAIL=admin@example.com   # Let's Encrypt — must be a real, deliverable address
```

Then start it:

```bash
cd /root/code/traefik-public/
docker compose -f compose.traefik.yml up -d
```

## Deploy Argus

Now that you have Traefik in place you can deploy Argus with Docker Compose (or skip ahead to [Continuous Deployment with GitHub Actions](#continuous-deployment-with-github-actions) to automate this).

### Copy the Code

```bash
rsync -av --filter=":- .gitignore" ./ root@your-server.example.com:/root/code/app/
```

`--filter=":- .gitignore"` makes `rsync` skip whatever git ignores (e.g. the Python virtual environment).

### Environment Variables

#### Generate secret keys

Some environment variables in the `.env` file have a default value of `changethis`.

You have to change them with a secret key, to generate secret keys you can run the following command:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Copy the content and use that as password / secret key. And run that again to generate another secure key.

#### Required Environment Variables

```bash
export ENVIRONMENT=production                 # local (dev default) / staging / production
export DOMAIN=argus.example.com                # local default: localhost
export POSTGRES_PASSWORD="<generated>"         # never leave as "changethis"
export SECRET_KEY="<generated>"                # signs auth tokens — use the command above
export FIRST_SUPERUSER_PASSWORD="<generated>"
export BACKEND_CORS_ORIGINS="https://dashboard.${DOMAIN?Variable not set},https://api.${DOMAIN?Variable not set}"
```

You can set several other environment variables:

* `PROJECT_NAME`: The name of the project, used in the API for the docs and emails.
* `STACK_NAME`: The name of the stack used for Docker Compose labels and project name, this should be different for `staging`, `production`, etc. You could use the same domain replacing dots with dashes, e.g. `argus-example-com` and `staging-argus-example-com`.
* `BACKEND_CORS_ORIGINS`: A list of allowed CORS origins separated by commas.
* `FIRST_SUPERUSER`: The email of the first superuser, this superuser will be the one that can create new users.
* `SMTP_HOST`: The SMTP server host to send emails, this would come from your email provider (E.g. Mailgun, Sparkpost, Sendgrid, etc).
* `SMTP_USER`: The SMTP server user to send emails.
* `SMTP_PASSWORD`: The SMTP server password to send emails.
* `EMAILS_FROM_EMAIL`: The email account to send emails from.
* `POSTGRES_SERVER`: The hostname of the PostgreSQL server. You can leave the default of `db`, provided by the same Docker Compose. You normally wouldn't need to change this unless you are using a third-party provider.
* `POSTGRES_PORT`: The port of the PostgreSQL server. You can leave the default. You normally wouldn't need to change this unless you are using a third-party provider.
* `POSTGRES_DB`: The database name to use for this application. You can leave the default of `argus`.
* `SENTRY_DSN`: The DSN for Sentry, if you are using it.
* `DOCKER_IMAGE_BACKEND` / `DOCKER_IMAGE_PINGSVC` / `DOCKER_IMAGE_FRONTEND`: image names used to build/tag the backend, pingsvc, and frontend images.
* `FRONTEND_TARGET` / `FRONTEND_PORT`: which stage of `frontend/Dockerfile` to build and the port Traefik routes to. The defaults (`dev`/`5173`) run the hot-reload Vite server — **production deploys must set `FRONTEND_TARGET=prod` and `FRONTEND_PORT=80`** to serve the static nginx build instead.
* `ROLE`: `client` (default, full zone stack) or `server` (central argus-server — no Redis/pingsvc; combine with omitting the `client` compose profile, see `scripts/run.sh`).

See [Multi-zone configuration](#multi-zone-configuration) below for the additional `ARGUS_*`/`S3_*` variables used by an `argus-client` zone or a central `argus-server`.

### Deploy with Docker Compose

With the environment variables in place, you can deploy with Docker Compose:

```bash
cd /root/code/app/
docker compose -f compose.yml build
docker compose -f compose.yml up -d
```

For production you wouldn't want to have the overrides in `compose.override.yml`, that's why we explicitly specify `compose.yml` as the file to use.

## Multi-zone configuration

Argus can run as a single stack (the default — nothing below needs to be set), or split into independent **zones** (`argus-client`, one per building/site) pushing signed status snapshots to a central **argus-server**. See the [architecture diagram in README.md](README.md#architecture) and the fully worked local walkthrough in [development.md](development.md#running-a-full-argus-client--argus-server-locally) for how the pieces fit together — this section only covers the production-specific parts: real S3 (not the local MinIO used in development) and credential handling.

### Deploying a zone (argus-client)

Set on the `pingsvc` service (directly, or via secrets referenced in its `environment:` block):

| Variable | Purpose |
|---|---|
| `ARGUS_ROLE` | `both` — runs the ping pipeline and the exporter in the same process |
| `ARGUS_ZONE_ID`, `ARGUS_TENANT_ID` | identify this zone in the object storage key layout and on the server's dashboard |
| `ARGUS_S3_BUCKET` | the shared bucket zones push to; leave the endpoint/access-key vars unset to use real AWS S3 with the AWS SDK's default credential chain (IAM role, instance profile) rather than static keys |
| `ARGUS_S3_ACCESS_KEY` / `ARGUS_S3_SECRET_KEY` | only needed for a static IAM user (the plan's MVP credential model) or a non-AWS S3-compatible provider; prefer an IAM role in production if your infrastructure supports it |
| `ARGUS_SIGNING_KEY_PATH` | must point at a path on a **persistent volume** — the exporter generates this zone's Ed25519 key once and expects to reuse it forever after. A new key on every restart breaks the server's registered-key trust model entirely. `compose.yml` mounts the named volume `argus-data` at `/var/lib/argus` (also home to the spool dir), so `/var/lib/argus/signing.key` is the natural choice. |

Bucket/IAM provisioning itself (creating the bucket, the scoped `PutObject`-only policy for this zone's prefix) is an ops/Terraform task, not something the application does — see the plan doc's `plan/dynamic-hierarchy-multi-zone-architecture.md` §4.4 for the recommended IAM shape (one shared bucket, per-tenant/zone prefixes, a writer role restricted to its own prefix).

### Deploying the server (argus-server)

Set on the `backend` service:

| Variable | Purpose |
|---|---|
| `S3_BUCKET` | enables the ingestion background task; unset = plain zone backend, no ingestion |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | a read-only credential (`GetObject`+`ListBucket`, no write) across all zones' prefixes — never reuse a zone's writer credential here |
| `INGESTION_INTERVAL_SECONDS` | how often the server polls the bucket for new snapshots (default 60s) |
| `STALENESS_THRESHOLD_SECONDS` | how long a zone can go without a successful pull before `GET /api/v1/zones/summary` reports it as stale (default 120s) |
| `SNAPSHOT_RETENTION_DAYS` | ingested snapshots older than this are pruned each cycle, keeping each zone's newest (default 7) |

A server instance doesn't need `pingsvc` running at all — it only ever reads from object storage, never talks to a zone directly.

To let the server verify a zone's signed snapshots (rather than leaving `signature_verified` as `null`/unknown for everything from that zone), register that zone's Ed25519 **public** key as a superuser via `PUT /api/v1/zones/{tenant_id}/{zone_id}/signing-key` with body `{"public_key_hex": "<64-hex chars>"}` (the same call rotates a key in place; `GET` on the same path reads back the registered key). Never transmit or store a zone's *private* key anywhere but that zone's own persistent volume — only the public half is ever registered.

## Continuous Deployment with GitHub Actions

Two environments are already configured — `staging` and `production`. Each
deploys via a **GitHub-hosted** runner: it builds the three service images,
pushes them to a shared AWS ECR registry, then SSHes into that environment's
own plain EC2 instance and runs `docker compose pull && up -d`. No
self-hosted runner is installed anywhere — the only thing that has to exist
ahead of time per environment is the EC2 box itself, provisioned once by
hand. Add more environments by using these as a starting point.

### Provision an environment's EC2 instance (one-time, per environment)

1. Launch a plain EC2 instance (`t4g.small`/Graviton is enough for this
   project's footprint; not attached to any ECS cluster or other
   orchestrator — this is a bare box `docker compose` runs directly on).
2. Attach an IAM **instance profile** granting ECR pull access (the managed
   policy `AmazonEC2ContainerRegistryReadOnly` is sufficient) — this is how
   the box authenticates to ECR later, no static AWS keys ever live on it.
3. Security group: `22` (SSH — key-only auth, password auth disabled; note
   that GitHub-hosted runners don't have stable source IPs, so this can't be
   restricted to a fixed CIDR the way an office IP could be — key-only auth
   plus `fail2ban` is the practical mitigation; [SSM Session
   Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
   is a more secure alternative worth graduating to later), `80`/`443` for
   Traefik.
4. Install Docker Engine + the Compose plugin. Create a `deploy` user in the
   `docker` group, and add the CI deploy keypair's **public** key to
   `~deploy/.ssh/authorized_keys` (the private half becomes the
   `EC2_SSH_PRIVATE_KEY` secret below — generate a dedicated keypair per
   environment or share one, your call).
5. `mkdir -p /home/deploy/code/app`, `docker network create traefik-public`,
   then bring up `compose.traefik.yml` exactly as in [Public
   Traefik](#public-traefik) above.
6. Bootstrap `/home/deploy/code/app/.env` with every app secret from the
   table below (`chmod 600`) — this file is persistent and only ever
   *edited in place* by the deploy step (it patches `TAG`/`DOCKER_IMAGE_*`
   before each `docker compose pull`), never regenerated from CI.

### One-time AWS + GitHub OIDC setup (shared across environments)

1. Create three ECR repositories: `argus-backend`, `argus-frontend`,
   `argus-pingsvc`.
2. Create an IAM OIDC identity provider for
   `token.actions.githubusercontent.com` (if this AWS account doesn't
   already have one — [GitHub's
   guide](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)),
   then an IAM role trusted by it, scoped to this repository, with push
   access to the three ECR repos above. This role's ARN is what
   `AWS_DEPLOY_ROLE_ARN` (below) points at — GitHub Actions assumes it via
   OIDC on every run, so no long-lived AWS access keys are ever stored as
   repository secrets.

### Set Secrets and Variables

On your repository, configure secrets and variables for the values below.
Follow the official guides for [repository
secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository)
and [repository
variables](https://docs.github.com/en/actions/learn-github-actions/variables#creating-configuration-variables-for-a-repository)
(variables are for non-sensitive values, under the same Settings page's
"Variables" tab).

**Variables:**

* `AWS_REGION`
* `AWS_ACCOUNT_ID`

**Secrets** — the current GitHub Actions workflows expect:

* `AWS_DEPLOY_ROLE_ARN` — the OIDC role from the AWS setup above
* `EC2_HOST_STAGING`, `EC2_HOST_PRODUCTION` — each environment's box
* `EC2_SSH_USER` — the `deploy` user created during provisioning
* `EC2_SSH_PRIVATE_KEY`
* `DOMAIN_PRODUCTION`
* `DOMAIN_STAGING`
* `STACK_NAME_PRODUCTION`
* `STACK_NAME_STAGING`
* `EMAILS_FROM_EMAIL`
* `FIRST_SUPERUSER`
* `FIRST_SUPERUSER_PASSWORD`
* `POSTGRES_PASSWORD`
* `POSTGRES_DB`
* `POSTGRES_PORT`
* `SECRET_KEY`
* `SENTRY_DSN`
* `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`
* `LATEST_CHANGES` — used by the separate `latest-changes` workflow, not deploy
* `SMOKESHOW_AUTH_KEY` — used by the separate `smokeshow` coverage-publishing workflow, not deploy

`DOCKER_IMAGE_BACKEND`/`DOCKER_IMAGE_PINGSVC`/`DOCKER_IMAGE_FRONTEND` are
**no longer secrets** — CI computes the ECR image URIs itself from
`AWS_ACCOUNT_ID`/`AWS_REGION` and writes them into the box's `.env` as part
of each deploy.

`deploy-staging.yml` and `deploy-production.yml` don't currently read any
`ARGUS_*`/`S3_*` secrets — if you're deploying a zone or server that needs
them, add them as additional repository secrets and bake them into the
box's persistent `.env` during provisioning (see [Multi-zone
configuration](#multi-zone-configuration)).

### Triggers

* `staging`: after pushing (or merging) to the branch `main`.
* `production`: after publishing a release.

## URLs

Replace `argus.example.com` with your domain.

| | Production | Staging |
|---|---|---|
| API docs | `https://api.argus.example.com/docs` | `https://api.staging.argus.example.com/docs` |
| API base URL | `https://api.argus.example.com` | `https://api.staging.argus.example.com` |

Traefik dashboard (shared, not per-environment): `https://traefik.argus.example.com`
