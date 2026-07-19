# Running the whole stack locally

Run the entire server-side stack on your laptop against a **disposable local
PLC** — no cloud, and nothing written to the public `plc.directory`. This is
how to iterate on the engine / auth and to verify the **AT Proto service auth +
self-hosted OpenFGA** path end to end.

> The `scripts/` stay focused on the real demo. Everything below is throwaway:
> put scratch files in `.local/` (gitignored) and tear the stack down when done.

## What comes up

Using the base compose plus a small dev-PLC override (you create it in step 1):

| Service | Role |
|---|---|
| `pds` | AT Proto Personal Data Server (dev mode, on `localhost:3000`) |
| `plc` + `plc-db` | A self-contained PLC directory — agent DIDs register here, not on the public ledger |
| `fga` + `fga-db` + `fga-migrate` + `fga-init` | Self-hosted **OpenFGA** — store + auth model bootstrapped on first boot |
| `engine` | The game engine / enforcement point (on `localhost:8091`) |

`caddy` (TLS/real-domain front) is skipped locally.

## Prerequisites

- Docker, with a few GB free in its VM. Check with `docker system df`; if you
  hit `No space left on device`, reclaim with `docker builder prune -af`.
- Node 20+ and `npm install` already run at the repo root.

## 1. Scratch files: secrets + the dev-PLC override

Throwaway secrets:

```bash
mkdir -p .local
cat > .local/local.env <<EOF
DOMAIN=beckitrue.com
PDS_ADMIN_PASSWORD=$(openssl rand -hex 16)
PDS_JWT_SECRET=$(openssl rand -hex 16)
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32)
FGA_STORE_ID=
FGA_MODEL_ID=
EOF
```

The dev-PLC compose override. It's kept here rather than in `infra/` so the
top-level stack stays demo-focused — it runs a self-contained PLC directory
(built from a pinned upstream commit), points the PDS and engine at it, exposes
both on localhost, and puts the PDS in dev mode (required to accept the
non-HTTPS local PLC). Save it next to the env file:

```bash
cat > .local/docker-compose.dev-plc.yml <<'EOF'
services:
  plc-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: plc
      POSTGRES_PASSWORD: plc
      POSTGRES_DB: plc
    volumes:
      - plc_db_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U plc -d plc']
      interval: 5s
      timeout: 5s
      retries: 12

  plc:
    build:
      context: 'https://github.com/did-method-plc/did-method-plc.git#2ed82a5ccf1b424aa5e2f6c5b461dc0ee133278b'
      dockerfile: packages/server/Dockerfile
    restart: unless-stopped
    environment:
      # The service entrypoint takes JSON creds (not DATABASE_URL) and runs
      # migrations on boot when ENABLE_MIGRATIONS=true.
      DB_CREDS_JSON: '{"username":"plc","password":"plc","host":"plc-db","port":"5432","database":"plc"}'
      DB_MIGRATE_CREDS_JSON: '{"username":"plc","password":"plc","host":"plc-db","port":"5432","database":"plc"}'
      ENABLE_MIGRATIONS: 'true'
      PORT: '3000'
      LOG_ENABLED: 'true'
      LOG_LEVEL: 'info'
    depends_on:
      plc-db:
        condition: service_healthy

  pds:
    ports:
      - '127.0.0.1:3000:3000'
    environment:
      - PDS_DID_PLC_URL=http://plc:3000
      - PDS_DEV_MODE=true
    depends_on:
      - plc

  engine:
    ports:
      - '127.0.0.1:8091:8080'
    environment:
      - PLC_DIRECTORY_URL=http://plc:3000

volumes:
  plc_db_data:
EOF
```

## 2. Bring up the stack

```bash
docker compose \
  -f infra/docker-compose.yml \
  -f .local/docker-compose.dev-plc.yml \
  --env-file .local/local.env \
  -p atproto-local up -d --scale caddy=0
```

First run builds the engine and PLC images (the PLC builds from upstream — a
few minutes, cached after).

Wait until both are healthy:

```bash
curl -sf http://localhost:3000/xrpc/_health && echo " pds ok"
curl -s  http://localhost:8091/games/nope            # {"error":"game not found"} → engine ok
```

## 3. Verify service auth + OpenFGA end to end

Each agent mints a service-auth token from the local PDS (`iss` = its DID); the
engine verifies it by resolving that DID **via the local PLC**, then OpenFGA
gates the move. Save this as `.local/verify-local.mjs`:

```js
#!/usr/bin/env node
import { mintServiceAuth } from '../scripts/lib/service-auth.mjs'

const PDS = 'http://localhost:3000'
const ENGINE = 'http://localhost:8091'
// The engine's default audience (agents mint aud = this; the engine only
// resolves the ISSUER DID, so this needn't be a real local account).
const ENGINE_DID = 'did:plc:xgdzu5egqclsjtiwiv7rkf2k'
const ADMIN = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN) throw new Error('set PDS_ADMIN_PASSWORD (source .local/local.env)')

const adminHeaders = {
  authorization: 'Basic ' + Buffer.from(`admin:${ADMIN}`).toString('base64'),
  'content-type': 'application/json',
}
const rnd = Math.random().toString(36).slice(2, 7)
async function createAccount(label) {
  const handle = `${label}${rnd}.beckitrue.com`
  const { code } = await (
    await fetch(`${PDS}/xrpc/com.atproto.server.createInviteCode`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ useCount: 1 }) })
  ).json()
  const password = 'pw-' + Math.random().toString(36).slice(2, 14)
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${handle}@example.com`, handle, password, inviteCode: code }),
  })
  if (!res.ok) throw new Error(`createAccount ${handle}: ${res.status} ${await res.text()}`)
  const { did } = await res.json()
  console.log(`  ✓ ${handle} → ${did}`)
  return { handle, password, did }
}

let fail = 0
const check = (label, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) fail++ }
async function api(method, path, token, body) {
  const res = await fetch(`${ENGINE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let b; try { b = await res.json() } catch { b = {} }
  return { status: res.status, body: b }
}

console.log('provisioning roster on the local PDS (DIDs on the local dev PLC)…')
const a = {
  rs: await createAccount('rs'), ro: await createAccount('ro'),
  bs: await createAccount('bs'), bo: await createAccount('bo'),
  guest: await createAccount('gu'),
}
const mint = (acct, aud = ENGINE_DID) => mintServiceAuth({ pds: PDS, identifier: acct.handle, password: acct.password, audienceDid: aud })

const GAME = `local-${Date.now()}`
console.log(`\ngame ${GAME} (writes real OpenFGA tuples):`)
const created = await api('POST', '/games', null, {
  id: GAME, seed: 1,
  roles: { spymasterRed: a.rs.did, operativeRed: a.ro.did, spymasterBlue: a.bs.did, operativeBlue: a.bo.did },
})
check('created', created.status === 200, `turn=${created.body.state?.turn}`)
const first = created.body.state.turn
const onSpy = first === 'red' ? a.rs : a.bs
const onOp = first === 'red' ? a.ro : a.bo
const offSpy = first === 'red' ? a.bs : a.rs

console.log('\nauthentication (AT Proto service auth):')
check('valid token accepted → engine resolved DID via local PLC',
  (await api('POST', `/games/${GAME}/clue`, await mint(onSpy), { word: 'nebula', count: 2 })).status === 200)
check('garbage token → 401', (await api('POST', `/games/${GAME}/clue`, 'not.a.jwt', { word: 'x', count: 1 })).status === 401)
check('wrong-aud token → 401', (await api('POST', `/games/${GAME}/guess`, await mint(onOp, onOp.did), { word: 'anchor' })).status === 401)

console.log('\nauthorization (self-hosted OpenFGA):')
check('off-turn clue → 403 denied_authz', (await api('POST', `/games/${GAME}/clue`, await mint(offSpy), { word: 'sneaky', count: 3 })).body.outcome === 'denied_authz')
check('operative reads key → 403', (await api('GET', `/games/${GAME}/key`, await mint(onOp))).status === 403)
check('spymaster reads key → 200 (25 cards)', (await api('GET', `/games/${GAME}/key`, await mint(onSpy))).body.key?.length === 25)
check('guest (no tuple) → 403 denied_authz — voice, not authority', (await api('POST', `/games/${GAME}/guess`, await mint(a.guest), { word: 'anchor' })).body.outcome === 'denied_authz')

console.log(fail === 0 ? '\n✅ LOCAL VERIFY PASSED' : `\n❌ FAILED: ${fail} check(s)`)
process.exit(fail === 0 ? 0 : 1)
```

Run it:

```bash
set -a; source .local/local.env; set +a
node .local/verify-local.mjs
```

Expected:

```
provisioning roster on the local PDS (DIDs on the local dev PLC)…
  ✓ rs….beckitrue.com → did:plc:…
  … (5 accounts)
game local-…:
  ✓ created — turn=blue
authentication (AT Proto service auth):
  ✓ valid token accepted → engine resolved DID via local PLC
  ✓ garbage token → 401
  ✓ wrong-aud token → 401
authorization (self-hosted OpenFGA):
  ✓ off-turn clue → 403 denied_authz
  ✓ operative reads key → 403
  ✓ spymaster reads key → 200 (25 cards)
  ✓ guest (no tuple) → 403 denied_authz — voice, not authority
✅ LOCAL VERIFY PASSED
```

## 4. Tear down

```bash
docker compose \
  -f infra/docker-compose.yml \
  -f .local/docker-compose.dev-plc.yml \
  --env-file .local/local.env \
  -p atproto-local down -v
```

## Notes & gotchas

- **Local PLC ≠ the real network.** DIDs created here register only on the
  local PLC, so they do **not** resolve on the live Bluesky network. To rehearse
  federation or the foreign-guest beat, drop the override (run the base compose
  alone) — the stack then uses the public `plc.directory` (which *does* write to
  that shared ledger).
- **Reserved / length-limited handles.** The PDS rejects reserved words
  (`guest`, `visitor`, `admin`, …) and handles beyond its length cap; the script
  above uses short random handle labels to sidestep both.
- **Token audience.** `ENGINE_DID` defaults to the referee DID. The engine only
  resolves the token's *issuer*, so the audience value needn't be a real local
  account — matching strings is enough.
- **Prod equivalent.** `scripts/smoke-engine.mjs` runs the same beats against a
  deployed stack using the real DIDs in `infra/agents.json` and each agent's
  `<PREFIX>_PDS_PASSWORD` (see `docs/DEMO-RUNBOOK.md`). This page is the
  from-scratch, fully-local counterpart.
