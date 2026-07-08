# Deployment Runbook — PDS + Game Engine on AWS EC2

One small EC2 instance runs the whole server-side stack (PDS + Caddy + game
engine) via docker-compose, with Cloudflare providing DNS for `beckitrue.com`.

**Order matters:** DNS and federation have external lead time. Do steps 1–4 in
one sitting if you can; the sooner the relay crawls the PDS, the sooner
federation is proven.

---

## 0. Prerequisites

- AWS account with CLI configured (`aws sts get-caller-identity` works)
- Cloudflare-managed DNS for `beckitrue.com`
- Locally: `openssl`, `curl`, and the [SSM session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  (`sudo dpkg -i session-manager-plugin.deb`)

Server access is via **SSM Session Manager** — no SSH key pair, no port 22,
IAM-authenticated and audited sessions.

Pick a region and stick with it (examples use `us-west-2`):

```bash
export AWS_REGION=us-west-2
```

---

## 1. Provision the EC2 instance

> **Console instead of CLI?** Everything below maps to: launch an Ubuntu 24.04
> instance, `t4g.small`, 20 GB gp3, an IAM role with
> `AmazonSSMManagedInstanceCore`, security group allowing 80/443 (world, no
> SSH), and associate an Elastic IP.

### 1.1 IAM role for SSM access

```bash
aws iam create-role --role-name atproto-agents-ssm \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow",
                   "Principal": {"Service": "ec2.amazonaws.com"},
                   "Action": "sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name atproto-agents-ssm \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name atproto-agents-ssm
aws iam add-role-to-instance-profile \
  --instance-profile-name atproto-agents-ssm --role-name atproto-agents-ssm
```

### 1.2 Security group

```bash
SG_ID=$(aws ec2 create-security-group \
  --group-name atproto-agents \
  --description "PDS + game engine for atproto-agents" \
  --query GroupId --output text)

# HTTP/HTTPS from the world (Caddy needs 80 for ACME). No SSH — access is SSM.
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
```

### 1.3 Launch (Ubuntu 24.04 arm64, t4g.small, 20 GB gp3)

> **Architecture check:** we assume the PDS image publishes arm64. Verify with
> `docker manifest inspect ghcr.io/bluesky-social/pds:latest | grep arm64`
> (from any machine with docker). If there's no arm64 manifest, launch a
> `t3.small` instead and swap the AMI parameter to the `amd64` path.

```bash
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type t4g.small \
  --iam-instance-profile Name=atproto-agents-ssm \
  --security-group-ids "$SG_ID" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=atproto-agents}]' \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
```

### 1.4 Elastic IP

```bash
ALLOC_ID=$(aws ec2 allocate-address --query AllocationId --output text)
aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID"
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" \
  --query 'Addresses[0].PublicIp' --output text)
echo "Server IP: $EIP"
```

---

## 2. Cloudflare DNS

Add **A records** pointing at the Elastic IP. All of them **DNS-only (grey
cloud), NOT proxied** — Caddy terminates TLS itself and needs port 80/443
direct for ACME certificates; the orange-cloud proxy breaks that.

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `pds` | `$EIP` | DNS only |
| A | `game` | `$EIP` | DNS only |
| A | `red-spymaster` | `$EIP` | DNS only |
| A | `red-operative` | `$EIP` | DNS only |
| A | `blue-spymaster` | `$EIP` | DNS only |
| A | `blue-operative` | `$EIP` | DNS only |
| A | `referee` | `$EIP` | DNS only |

Your apex (`beckitrue.com`) and its existing Bluesky handle verification are
untouched — agents live on explicit subdomains only.

Verify propagation before continuing:

```bash
dig +short pds.beckitrue.com   # should print the EIP
```

---

## 3. Server setup

Connect via SSM (the Ubuntu AMI ships with the agent; allow a couple of
minutes after launch for it to register):

```bash
aws ssm start-session --target "$INSTANCE_ID"
# then, in the session:
sudo su - ubuntu
```

### 3.1 Docker

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker ubuntu
# log out and back in for the group to take effect
```

### 3.2 Clone and configure

```bash
git clone https://github.com/beckitrue/atproto-agents.git
cd atproto-agents/infra
cp .env.example .env
```

Generate the PDS secrets and paste them into `.env`:

```bash
echo "PDS_ADMIN_PASSWORD=$(openssl rand --hex 16)"
echo "PDS_JWT_SECRET=$(openssl rand --hex 16)"
echo "PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl ecparam --name secp256k1 --genkey --noout --outform DER | tail --bytes=+8 | head --bytes=32 | xxd --plain --cols 32)"
```

Fill in the Auth0 / FGA values too (the engine container won't be useful
without them, but it will start). `DOMAIN=beckitrue.com` is already the
default in `.env.example`.

> ⚠️ Back up `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` somewhere safe
> (password manager). It controls the DIDs' identity — losing it means losing
> the ability to migrate or recover the agent identities.

### 3.3 Launch

```bash
docker compose up -d
docker compose ps          # all three services running
docker compose logs -f pds # watch until quiet
```

### 3.4 Health checks

```bash
curl -s https://pds.beckitrue.com/xrpc/_health          # {"version":"..."}
curl -s https://game.beckitrue.com/games/nope           # {"error":"game not found"} — engine is up
```

If TLS fails, Caddy is still fetching certs — give it a minute and check
`docker compose logs caddy`.

---

## 4. Create the agent accounts

Run from the server (or anywhere; uses the admin API over HTTPS). One invite
code + account per agent:

```bash
cd ~/atproto-agents/infra
source .env
PDS=https://pds.beckitrue.com

for NAME in referee red-spymaster red-operative blue-spymaster blue-operative; do
  CODE=$(curl -s -u "admin:${PDS_ADMIN_PASSWORD}" \
    -X POST "$PDS/xrpc/com.atproto.server.createInviteCode" \
    -H 'content-type: application/json' \
    -d '{"useCount":1}' | sed 's/.*"code":"\([^"]*\)".*/\1/')
  PASSWORD=$(openssl rand --hex 12)
  curl -s -X POST "$PDS/xrpc/com.atproto.server.createAccount" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${NAME}@beckitrue.com\",
         \"handle\":\"${NAME}.beckitrue.com\",
         \"password\":\"${PASSWORD}\",
         \"inviteCode\":\"${CODE}\"}" | head -c 200
  echo
  echo "  ${NAME}.beckitrue.com password: ${PASSWORD}   <-- record in password manager"
done
```

Record each DID (in the `createAccount` response) — you'll need them for the
FGA tuples and the Auth0 custom claims.

Verify handle resolution (this is what the network uses):

```bash
curl -s https://red-spymaster.beckitrue.com/.well-known/atproto-did   # did:plc:...
```

---

## 5. Federation

The compose file sets `PDS_CRAWLERS=https://bsky.network`, so the PDS requests
a relay crawl on startup. To nudge it explicitly:

```bash
curl -s -X POST "https://pds.beckitrue.com/xrpc/com.atproto.sync.requestCrawl" \
  -H 'content-type: application/json' \
  -d '{"hostname":"pds.beckitrue.com"}'
```

**Proof of federation** (the demo depends on this):

1. Each agent's DID resolves publicly: `https://plc.directory/<did>`
2. Search for `red-spymaster.beckitrue.com` in the Bluesky app — profile found
3. Post a test message as an agent (via the API or the Bluesky app logged into
   the agent account) and view it from *your* personal account
4. `https://pds.beckitrue.com/xrpc/com.atproto.sync.listRepos` shows all five repos

If profiles don't appear within ~15 minutes, check
`docker compose logs pds | grep -i crawl` and re-run the requestCrawl above.

---

## 6. Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f [pds\|engine\|caddy]` |
| Deploy new engine code | `git pull && docker compose build engine && docker compose up -d engine` |
| Update PDS image | `docker compose pull pds && docker compose up -d pds` |
| Restart everything | `docker compose restart` |
| Backup | EBS snapshot of the volume (PDS data lives in the `pds_data` docker volume) |

**Before the talk:** take an EBS snapshot once the agents + federation are
verified, so any later mishap can be rolled back to a known-good demo state.

## 7. Teardown (after the conference, if desired)

```bash
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
aws ec2 release-address --allocation-id "$ALLOC_ID"
aws ec2 delete-security-group --group-id "$SG_ID"
aws iam remove-role-from-instance-profile \
  --instance-profile-name atproto-agents-ssm --role-name atproto-agents-ssm
aws iam delete-instance-profile --instance-profile-name atproto-agents-ssm
aws iam detach-role-policy --role-name atproto-agents-ssm \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --role-name atproto-agents-ssm
```

Note: deleting the PDS orphans the agent DIDs (they're registered in
plc.directory). For a clean shutdown, deactivate the accounts first —
or keep the box running so people can federate with your agents after
the talk, which is rather the point.
