# ECS deploy — one-time bring-up

Argus deploys to `staging` and `production` as a single ECS task (EC2 launch
type) with 7 sidecar containers — the same topology `compose.yml` runs
locally, just orchestrated by ECS instead of `docker compose` directly. Once
the one-time setup below is done, day-to-day deploys are fully AWS-managed:
CI builds images, pushes them to ECR, renders the new tag into the task
definition, and calls `register-task-definition` + `update-service` — no
SSH, no self-hosted runner, nothing to reach into by hand.

Run `aws sts get-caller-identity --query Account --output text` once and
substitute that value everywhere `REPLACE_ACCOUNT_ID` appears below and in
`staging-taskdef.json`/`production-taskdef.json`. Also replace `REPLACE_*`
placeholders (domain, admin email, tenant id, region) throughout — including
inside `traefik-dynamic.staging.yml`/`traefik-dynamic.production.yml`.

Everything below is written generically for one environment — substitute
`staging` or `production` (and the matching task-def/dynamic-config file)
throughout. Do staging first, confirm it works, then repeat for production.

## 1. ECS cluster (EC2 launch type)

If the cluster doesn't already exist (`aws ecs list-clusters`): create one
(`t4g.small`, Graviton — matches the images below being built `arm64`), 1
instance, security group open on `22` (SSH — key-only auth; used only for
the one-time host bootstrap in step 4, not by CI), `80`/`443` (Traefik),
named `argus-<env>`.

## 2. ECR repos + push images (arm64 — the cluster's instances are Graviton)

CI does this on every deploy (see `.github/workflows/deploy-staging.yml` /
`deploy-production.yml`) — this is only for the *first* image, since an ECS
service can't be created against a task definition whose images don't exist
yet:

```bash
for repo in argus-backend argus-frontend argus-pingsvc; do
  aws ecr create-repository --repository-name "$repo" --region REPLACE_REGION
done

aws ecr get-login-password --region REPLACE_REGION | \
  docker login --username AWS --password-stdin REPLACE_ACCOUNT_ID.dkr.ecr.REPLACE_REGION.amazonaws.com

docker buildx build --platform linux/arm64 -f backend/Dockerfile \
  -t REPLACE_ACCOUNT_ID.dkr.ecr.REPLACE_REGION.amazonaws.com/argus-backend:bootstrap --push .

docker buildx build --platform linux/arm64 -f frontend/Dockerfile --target prod \
  -t REPLACE_ACCOUNT_ID.dkr.ecr.REPLACE_REGION.amazonaws.com/argus-frontend:bootstrap --push .

docker buildx build --platform linux/arm64 -f pingsvc/Dockerfile \
  -t REPLACE_ACCOUNT_ID.dkr.ecr.REPLACE_REGION.amazonaws.com/argus-pingsvc:bootstrap --push ./pingsvc
```

(ECR repos are shared across environments — do this once, not per environment.)

## 3. SSM Parameter Store secrets (SecureString, free tier — no Secrets Manager needed)

The task definition's containers read these directly via `secrets:` entries
pointing at these ARNs — no `.env` file, nothing for CI to inject at deploy
time.

```bash
aws ssm put-parameter --name /argus/REPLACE_ENV/POSTGRES_PASSWORD --type SecureString \
  --value "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"

aws ssm put-parameter --name /argus/REPLACE_ENV/SECRET_KEY --type SecureString \
  --value "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"

aws ssm put-parameter --name /argus/REPLACE_ENV/FIRST_SUPERUSER_PASSWORD --type SecureString \
  --value "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
```

(Skipped `PINGSVC_SYNC_TOKEN`/`ARGUS_PINGSVC_SYNC_TOKEN` — the task def
leaves pingsvc's target hot-reload disabled for this first pass. Add both
later the same way if you turn `ARGUS_BACKEND_URL` on.)

## 4. IAM roles

**Execution role** (lets the ECS agent pull from ECR, fetch the SSM
secrets above, and write to CloudWatch Logs):

```bash
aws iam create-role --role-name argus-REPLACE_ENV-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }'

aws iam attach-role-policy --role-name argus-REPLACE_ENV-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam put-role-policy --role-name argus-REPLACE_ENV-execution-role \
  --policy-name argus-REPLACE_ENV-ssm-read \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {"Effect": "Allow", "Action": "ssm:GetParameters", "Resource": "arn:aws:ssm:REPLACE_REGION:REPLACE_ACCOUNT_ID:parameter/argus/REPLACE_ENV/*"},
      {"Effect": "Allow", "Action": "kms:Decrypt", "Resource": "arn:aws:kms:REPLACE_REGION:REPLACE_ACCOUNT_ID:alias/aws/ssm"}
    ]
  }'
```

No **task role** yet — nothing in this task def calls AWS APIs from inside
the app since `S3_BUCKET`/`ARGUS_S3_BUCKET` are empty (plain zone backend,
`ARGUS_ROLE=pingsvc` only, no exporter). Add one later if you turn on
multi-zone S3 export.

**GitHub Actions deploy role** (one-time, shared across environments —
what `AWS_DEPLOY_ROLE_ARN` in the repo's GitHub secrets points at; lets CI
push to ECR and call the ECS deploy APIs via OIDC, no long-lived AWS keys
as GitHub secrets):

1. Create an IAM OIDC identity provider for
   `token.actions.githubusercontent.com`, if this account doesn't already
   have one ([GitHub's
   guide](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)).
2. Create a role trusted by that provider, scoped to this repository, with:
   push access to the three `argus-*` ECR repos, `ecs:RegisterTaskDefinition`,
   `ecs:UpdateService`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`,
   and `iam:PassRole` on both environments' execution roles (needed because
   `RegisterTaskDefinition` requires permission to pass the execution role
   to ECS).

## 5. Host paths + static Traefik config, via SSM Session Manager

Connect to the running instance (find its instance ID in the EC2 console, or
`aws ecs list-container-instances --cluster argus-REPLACE_ENV`):

```bash
aws ssm start-session --target <instance-id>
```

Then on the instance:

```bash
sudo mkdir -p /opt/argus/{postgres-data,redis-data,argus-data,traefik-certs,traefik-dynamic}
sudo touch /opt/argus/targets.txt   # pingsvc's target list -- populate with real device IPs
sudo touch /opt/argus/hierarchy.yaml   # optional -- see hierarchy.md; leave empty to skip seeding
```

Copy `traefik-dynamic.staging.yml` (or `.production.yml`) from this repo
onto the instance as `/opt/argus/traefik-dynamic/dynamic.yml`, with its
`REPLACE_*` placeholders filled in first — either paste it via
`aws ssm send-command`, or `sudo tee` it in directly during the session.

## 6. Register the task definition

Edit `staging-taskdef.json` (or `production-taskdef.json`) — account ID,
region, domain, admin email, tenant id already called out above — then:

```bash
aws ecs register-task-definition --cli-input-json file://ecs/staging-taskdef.json
```

## 7. Create the service

Console: refresh the "Task definition family" dropdown on the Create
Service screen — `argus-REPLACE_ENV` should now appear. Service name
`argus-client`, desired count `1`, capacity provider strategy `Use cluster
default`. Create the service. (Or `aws ecs create-service` with the
equivalent flags — the family/service names above match what
`.github/workflows/deploy-*.yml` already expects.)

Once it's running: point your domain's DNS A record (`api.<env>.*`,
`dashboard.<env>.*`, `traefik.<env>.*`) at the instance's public IP
(reserve it as an Elastic IP so it survives instance replacement), then hit
`https://dashboard.<env>.<yourdomain>`.

From here on, deploys are just pushes to `main` (staging) or published
releases (production) — CI does the rest.

## A memory-budget caveat worth watching

`t4g.small` is 2 GiB total. Soft-reserved memory across the 7 containers
here (traefik 64 + db 400 + backend 300 + frontend 64 + redis 64 + pingsvc
512 hard-limited + prestart 128, transient) sums close to that ceiling once
the OS and ECS agent's own overhead are subtracted. If you see OOM kills in
`docker stats` or the ECS console's stopped-task reasons, the fix is
bumping the launch template's instance type to `t4g.medium` (4 GiB, ~+$12/mo).
