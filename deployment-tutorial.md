# Deploying Argus to AWS — client + server demo, step by step

This walks through deploying the full multi-zone demo from
[plan/argus-server-gaps-and-demo-deployment-v1.md](plan/argus-server-gaps-and-demo-deployment-v1.md) §4.2:
one **argus-client** zone box and one **argus-server** box on EC2, connected
*only* through an S3 bucket. Every command is meant to be run in order,
top to bottom.

> **Status**: authored ahead of the first real deployment (the plan's Phase 5
> calls for validating it during the actual deploy). Anything that turns out
> to differ in practice should be corrected here as it's hit — treat this
> file as the living runbook.

This document is the demo-specific, command-by-command companion to
[deployment.md](deployment.md), which documents each variable and the Traefik
setup in general terms. Where the two overlap, deployment.md is the reference;
this file is the recipe.

## What you're building

```
Instance A (t4g.small)  "argus-client"        Instance B (t4g.small)  "argus-server"
┌─────────────────────────────────┐           ┌─────────────────────────────────┐
│ Traefik (TLS)                   │           │ Traefik (TLS)                   │
│ frontend (nginx, prod build)    │           │ frontend (nginx, prod build)    │
│ backend ROLE=client             │           │ backend ROLE=server + S3_BUCKET │
│ pingsvc ARGUS_ROLE=both ── ICMP │           │ MySQL                           │
│ Redis · MySQL                   │           │ (no Redis, no pingsvc)          │
└──────────────┬──────────────────┘           └──────────────▲──────────────────┘
               │ PutObject (signed snapshots,                │ GetObject/ListBucket
               │  IAM instance profile, write-only)          │  (IAM instance profile, read-only)
               ▼                                             │
        ┌─────────────────────────────────────────────────────┐
        │ S3 bucket (private, 7-day lifecycle expiry)         │
        │   acme-corp/hq/YYYY/MM/DD/HH/<ts>.json.gz(+.manifest)│
        └─────────────────────────────────────────────────────┘
```

The two instances never talk to each other — S3 is the only interface. That's
the architecture the demo exists to show.

**Monthly cost**: ≈ $39 (2× t4g.small on-demand + 2× 20 GB gp3 + 2 public IPv4
+ S3 pennies) plus ~$10/yr for a domain.

## Prerequisites

- An AWS account and the AWS CLI v2 configured locally (`aws sts get-caller-identity` works).
- A domain you control, with DNS you can edit (Route 53 or any registrar).
- This repository checked out locally (you'll `rsync` it to the instances).
- An SSH keypair registered in EC2 (`aws ec2 describe-key-pairs`), or create
  one in Step 3.

## Step 0 — pick your names (once, in your local terminal)

Everything below reuses these. Bucket names are globally unique, so suffix
yours.

```bash
export AWS_REGION=us-east-1
export BUCKET=argus-metrics-$(whoami)-demo     # must be globally unique
export TENANT_ID=acme-corp
export ZONE_ID=hq
export BASE_DOMAIN=argus.example.com           # server UI lives here
export ZONE_DOMAIN=hq.argus.example.com        # client zone UI lives here
export KEY_NAME=argus-demo                     # EC2 SSH keypair name
```

The compose stack routes per instance by subdomain: the server UI will be
`https://dashboard.${BASE_DOMAIN}` and the zone UI
`https://dashboard.${ZONE_DOMAIN}` (API at `api.`, Traefik dashboard at
`traefik.`, same pattern on both).

## Step 1 — S3 bucket (private, encrypted, self-cleaning)

```bash
aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
  $( [ "$AWS_REGION" != us-east-1 ] && echo --create-bucket-configuration LocationConstraint="$AWS_REGION" )

# Belt and suspenders: new buckets block public access by default, keep it that way.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Snapshots are ~30s apart; without expiry the bucket grows forever.
# (The server also prunes its own DB copies after SNAPSHOT_RETENTION_DAYS=7.)
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-snapshots",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Expiration": {"Days": 7}
    }]
  }'
```

(Default SSE-S3 encryption is automatic on new buckets — nothing to do.)

## Step 2 — IAM: two roles, two instance profiles, no static keys

The client box may **only write** to its own zone prefix; the server box may
**only read**. Neither ever holds a static credential — the AWS SDK default
chain picks up the instance profile automatically because the compose files
leave `ARGUS_S3_ACCESS_KEY`/`S3_ACCESS_KEY` unset.

```bash
cat > /tmp/ec2-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

# ── Writer role for the zone (Instance A) ──────────────────────────────
aws iam create-role --role-name argus-client-writer \
  --assume-role-policy-document file:///tmp/ec2-trust.json

aws iam put-role-policy --role-name argus-client-writer \
  --policy-name put-own-zone-prefix \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"s3:PutObject\",
      \"Resource\": \"arn:aws:s3:::${BUCKET}/${TENANT_ID}/${ZONE_ID}/*\"
    }]
  }"

aws iam create-instance-profile --instance-profile-name argus-client-writer
aws iam add-role-to-instance-profile \
  --instance-profile-name argus-client-writer --role-name argus-client-writer

# ── Read-only role for the server (Instance B) ─────────────────────────
aws iam create-role --role-name argus-server-reader \
  --assume-role-policy-document file:///tmp/ec2-trust.json

aws iam put-role-policy --role-name argus-server-reader \
  --policy-name read-snapshot-bucket \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\",
       \"Resource\": \"arn:aws:s3:::${BUCKET}\"},
      {\"Effect\": \"Allow\", \"Action\": \"s3:GetObject\",
       \"Resource\": \"arn:aws:s3:::${BUCKET}/*\"}
    ]
  }"

aws iam create-instance-profile --instance-profile-name argus-server-reader
aws iam add-role-to-instance-profile \
  --instance-profile-name argus-server-reader --role-name argus-server-reader
```

## Step 3 — security groups and two EC2 instances

```bash
# SSH keypair, if you don't have one registered yet:
aws ec2 create-key-pair --key-name "$KEY_NAME" \
  --query 'KeyMaterial' --output text > ~/.ssh/${KEY_NAME}.pem
chmod 600 ~/.ssh/${KEY_NAME}.pem

export VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# One SG shared by both boxes: HTTP(S) from the world, SSH from your IP.
export MY_IP=$(curl -s https://checkip.amazonaws.com)
export SG_ID=$(aws ec2 create-security-group --group-name argus-demo \
  --description "argus demo: web + ssh" --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 80  --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22  --cidr ${MY_IP}/32
# Let the zone ping the server box, so the demo dashboard shows a real
# "up" device you control (optional but makes the demo much better):
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol icmp --port -1 --source-group "$SG_ID"

# Latest Ubuntu 24.04 ARM AMI, resolved via the public SSM parameter:
export AMI=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
  --query 'Parameter.Value' --output text)

launch() {  # launch <name> <instance-profile>
  aws ec2 run-instances --image-id "$AMI" --instance-type t4g.small \
    --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
    --iam-instance-profile Name="$2" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$1}]" \
    --query 'Instances[0].InstanceId' --output text
}

export ID_A=$(launch argus-client argus-client-writer)
export ID_B=$(launch argus-server argus-server-reader)
aws ec2 wait instance-running --instance-ids "$ID_A" "$ID_B"

export IP_A=$(aws ec2 describe-instances --instance-ids "$ID_A" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
export IP_B=$(aws ec2 describe-instances --instance-ids "$ID_B" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "client: $IP_A   server: $IP_B"
```

## Step 4 — DNS

At your DNS provider, create A records (or one wildcard per box):

| Record | Value |
|---|---|
| `*.${BASE_DOMAIN}` (or `dashboard.`, `api.`, `traefik.` individually) | `$IP_B` |
| `*.${ZONE_DOMAIN}` (ditto) | `$IP_A` |

Wait until `dig +short dashboard.${BASE_DOMAIN}` returns the right IP before
starting Traefik — Let's Encrypt validation fails (and rate-limits you) on
unpropagated records.

## Step 5 — base setup on both instances

Repeat this block for `$IP_A` and `$IP_B`:

```bash
ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@$IP_A   # then again with $IP_B
```

On the instance:

```bash
# Docker (official convenience script) + compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exit   # re-login to pick up the group
```

```bash
# t4g.small has 2 GB RAM; building the images needs headroom. One-time swap:
ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@$IP_A \
  'sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab'
```

Copy the code from your local checkout (from the repo root, per deployment.md):

```bash
rsync -av -e "ssh -i ~/.ssh/${KEY_NAME}.pem" --filter=":- .gitignore" \
  ./ ubuntu@$IP_A:/home/ubuntu/code/app/
rsync -av -e "ssh -i ~/.ssh/${KEY_NAME}.pem" \
  compose.traefik.yml ubuntu@$IP_A:/home/ubuntu/code/traefik-public/
# ...and the same two rsyncs to $IP_B
```

## Step 6 — Traefik on both instances

On **each** instance (adjust `DOMAIN` per box — this is the only difference):

```bash
docker network create traefik-public

cd ~/code/traefik-public/
export USERNAME=admin
export PASSWORD='<pick one>'
export HASHED_PASSWORD=$(openssl passwd -apr1 $PASSWORD)
export DOMAIN=hq.argus.example.com        # Instance A; argus.example.com on B
export EMAIL=you@yourdomain.com           # a real address; @example.com is rejected

docker compose -f compose.traefik.yml up -d
```

`https://traefik.<domain>` (basic-auth with the credentials above) confirms
it's up and getting certificates.

## Step 7 — Instance A: the argus-client zone

```bash
ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@$IP_A
cd ~/code/app
```

Create the production `.env` (start from `.env.example`). The demo-relevant
settings — generate each secret with
`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`:

```dotenv
ENVIRONMENT=production
DOMAIN=hq.argus.example.com
FRONTEND_HOST=https://dashboard.hq.argus.example.com
BACKEND_CORS_ORIGINS=https://dashboard.hq.argus.example.com,https://api.hq.argus.example.com
STACK_NAME=argus-hq
SECRET_KEY=<generated>
MYSQL_ROOT_PASSWORD=<generated>
FIRST_SUPERUSER=you@yourdomain.com
FIRST_SUPERUSER_PASSWORD=<generated>

# Serve the static production frontend, not the Vite dev server:
FRONTEND_TARGET=prod
FRONTEND_PORT=80

ROLE=client

# The exporter half (this is what makes it an argus-client):
ARGUS_ROLE=both
ARGUS_TENANT_ID=acme-corp
ARGUS_ZONE_ID=hq
ARGUS_S3_BUCKET=argus-metrics-<you>-demo
ARGUS_S3_REGION=us-east-1
# ARGUS_S3_ENDPOINT / ARGUS_S3_ACCESS_KEY / ARGUS_S3_SECRET_KEY stay UNSET:
# the SDK default chain uses the instance profile (argus-client-writer).
ARGUS_SIGNING_KEY_PATH=/var/lib/argus/signing.key
```

Give pingsvc something to ping. For the demo, a couple of public anycast IPs
plus the server box (reachable because of the ICMP SG rule), tagged with a
demo hierarchy:

```bash
cat > pingsvc/targets.txt <<EOF
8.8.8.8,${TENANT_ID};${ZONE_ID};rack-1
1.1.1.1,${TENANT_ID};${ZONE_ID};rack-1
<Instance B private IP>,${TENANT_ID};${ZONE_ID};rack-2
EOF
```

Build and start (explicitly `compose.yml` only — the override file is
local-dev):

```bash
docker compose -f compose.yml --profile client build
docker compose -f compose.yml --profile client up -d
```

Smoke-check the zone:

```bash
docker compose -f compose.yml logs pingsvc | grep exporter
# expect: "generated new signing key at /var/lib/argus/signing.key"
#         "pushed 1 snapshot(s) to object storage"

# From your local terminal — snapshots landing:
aws s3 ls "s3://$BUCKET/$TENANT_ID/$ZONE_ID/" --recursive | tail -3
```

Then log into `https://dashboard.hq.argus.example.com` with the
`FIRST_SUPERUSER` credentials: Dashboard shows live up/down counters and the
green **Live** WebSocket indicator; Devices shows per-address state.

## Step 8 — Instance B: the argus-server

```bash
ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@$IP_B
cd ~/code/app
```

`.env` (fresh secrets — do **not** reuse Instance A's):

```dotenv
ENVIRONMENT=production
DOMAIN=argus.example.com
FRONTEND_HOST=https://dashboard.argus.example.com
BACKEND_CORS_ORIGINS=https://dashboard.argus.example.com,https://api.argus.example.com
STACK_NAME=argus-server
SECRET_KEY=<generated>
MYSQL_ROOT_PASSWORD=<generated>
FIRST_SUPERUSER=you@yourdomain.com
FIRST_SUPERUSER_PASSWORD=<generated>

FRONTEND_TARGET=prod
FRONTEND_PORT=80

ROLE=server

# This is what makes it an argus-server:
S3_BUCKET=argus-metrics-<you>-demo
S3_REGION=us-east-1
# S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY stay UNSET → instance profile
# (argus-server-reader, read-only).
INGESTION_INTERVAL_SECONDS=60
STALENESS_THRESHOLD_SECONDS=120
SNAPSHOT_RETENTION_DAYS=7
```

No `--profile client` here — a server runs no Redis and no pingsvc:

```bash
docker compose -f compose.yml build
docker compose -f compose.yml up -d

docker compose -f compose.yml logs -f backend | grep -i ingestion
# expect within ~60s: "ingestion: ingested N new snapshot(s)"
```

Log into `https://dashboard.argus.example.com`: the nav leads with **Zones**
(no Dashboard/Devices — that's the role-aware UI working), and the zones table
shows `acme-corp / hq` as **Fresh** with live counts.

## Step 9 — register the zone's signing key

Until this step the zone's snapshots ingest with signature status *unknown*
("No signing key registered"). The key was generated on Instance A and its
**public half** is embedded in every manifest it pushes — read it from there
(the private key never leaves Instance A's `argus-data` volume):

```bash
# Local terminal:
MANIFEST=$(aws s3 ls "s3://$BUCKET/$TENANT_ID/$ZONE_ID/" --recursive \
  | grep manifest | tail -1 | awk '{print $4}')
aws s3 cp "s3://$BUCKET/$MANIFEST" - \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['public_key'])"
```

Then in the server UI (`https://dashboard.argus.example.com`): **Zones →
click the zone → Signing key panel → paste the 64-hex key → Register key**.
(Same panel rotates it later; the equivalent API call is
`PUT /api/v1/zones/{tenant_id}/{zone_id}/signing-key` — see deployment.md.)

Within one export + ingest cycle (~90 s), the zone detail badge flips to
**Signature verified**. While you're there, use the pencil next to the zone
title to give it a display name.

## Step 10 — prove the "zone went dark" story (optional, 2 min)

```bash
# On Instance A:
docker compose -f compose.yml stop pingsvc
```

Within `STALENESS_THRESHOLD_SECONDS` the server's Zones table flips the zone
to **Stale** — that's the server noticing a zone's WAN died without the zone
being able to self-report. `start pingsvc` again and it returns to Fresh, and
the spooled backlog (if any) uploads oldest-first.

## Ongoing operations

- **Deploying an update**: re-run the Step 5 `rsync`, then on the instance
  `docker compose -f compose.yml [--profile client] build && docker compose -f compose.yml [--profile client] up -d`.
  `prestart` runs Alembic migrations automatically before the backend starts.
- **Logs**: `docker compose -f compose.yml logs -f backend|pingsvc|proxy`.
- **DB backup** (optional; all demo data is reconstructible): nightly cron on
  each box:
  `docker compose -f compose.yml exec -T db mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" argus | gzip > backup-$(date +%F).sql.gz`
- **The signing key lives on the `argus-data` named volume** on Instance A.
  Deleting that volume regenerates the key on next start and the server will
  mark everything `Signature INVALID` until you re-register (Step 9's panel,
  "Rotate key").

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Let's Encrypt cert never issues | DNS not propagated yet, or port 80 blocked. Check `docker compose -f compose.traefik.yml logs` in `~/code/traefik-public`. Repeated failures hit LE rate limits — fix DNS first, then restart Traefik. |
| Every device shows Down | pingsvc lacks raw-socket capability. `compose.yml` ships `cap_add: [NET_RAW, NET_ADMIN]` — make sure you didn't remove it. Also: EC2 SG egress must allow ICMP (default all-egress does). |
| `pushed 0 snapshot(s)` / AccessDenied in pingsvc logs | Instance profile missing or the policy prefix doesn't match `ARGUS_TENANT_ID/ARGUS_ZONE_ID`. Check `curl -s http://169.254.169.254/latest/meta-data/iam/info` on the box. |
| Server logs `ingestion: no S3_BUCKET configured` | `.env` not picked up — `S3_BUCKET` must be set in the compose environment; `docker compose -f compose.yml config` to verify what the backend actually receives. |
| Zone stuck on "No signing key registered" after Step 9 | You registered a key that isn't the one in the latest manifests (e.g. the volume was recreated). Re-read the newest manifest's `public_key` and rotate. |
| Frontend shows the Vite dev server / port errors | `FRONTEND_TARGET`/`FRONTEND_PORT` not set to `prod`/`80` at **build** time — rebuild the frontend image after fixing `.env`. |
| Build dies on t4g.small | Add the 2 GB swapfile from Step 5. |

## Teardown

```bash
aws ec2 terminate-instances --instance-ids "$ID_A" "$ID_B"
aws ec2 wait instance-terminated --instance-ids "$ID_A" "$ID_B"
aws ec2 delete-security-group --group-id "$SG_ID"
aws s3 rm "s3://$BUCKET" --recursive && aws s3api delete-bucket --bucket "$BUCKET"
for r in argus-client-writer argus-server-reader; do
  aws iam remove-role-from-instance-profile --instance-profile-name $r --role-name $r
  aws iam delete-instance-profile --instance-profile-name $r
  aws iam delete-role-policy --role-name $r --policy-name \
    $( [ $r = argus-client-writer ] && echo put-own-zone-prefix || echo read-snapshot-bucket )
  aws iam delete-role --role-name $r
done
```

Plus the DNS records and (if created just for this) the EC2 keypair.

## What was deliberately skipped, and when to graduate

Per the plan (§4.2): no RDS (demo data is reconstructible — move to
single-AZ RDS when it isn't), no Terraform (clickops + this runbook is fine
for two boxes; codify when zone #3 appears), no ALB/CloudFront/WAF/k8s, no
Secrets Manager (per-box `chmod 600 .env`). Monitoring next steps: point
Prometheus at pingsvc's `:9090/metrics` and set `SENTRY_DSN` (already wired).
A Vercel-hosted server dashboard is possible later but needs `VITE_API_URL`
plumbing plus CORS first (plan Phase V).
