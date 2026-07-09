#!/usr/bin/env node
/**
 * Idempotent Auth0 tenant setup for the Codenames agent demo.
 *
 * Creates (or finds, if they already exist):
 *   1. The game engine API (resource server) — the token audience
 *   2. One M2M application per agent in infra/agents.json
 *   3. Client grants authorizing each app for the API
 *   4. A credentials-exchange Action that stamps each agent's AT Proto DID
 *      onto its access tokens as a custom claim (client_id → DID map)
 *
 * Reads AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET from
 * the environment (see infra/.env.example). Appends per-agent client
 * credentials to infra/.env (gitignored) — secrets are never printed.
 *
 * Usage:  set -a; source infra/.env; set +a; node scripts/setup-auth0.mjs
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
// Post-to-join guests (scripts/approve-join.mjs) get clients + DID claims too.
const guestsPath = join(ROOT, 'infra/guests.json')
const guests = existsSync(guestsPath) ? JSON.parse(readFileSync(guestsPath, 'utf8')) : []

const DOMAIN = process.env.AUTH0_DOMAIN
const MGMT_ID = process.env.AUTH0_MGMT_CLIENT_ID
const MGMT_SECRET = process.env.AUTH0_MGMT_CLIENT_SECRET
if (!DOMAIN || DOMAIN.startsWith('your-tenant') || !MGMT_ID || !MGMT_SECRET) {
  console.error('Set AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET (see infra/.env)')
  process.exit(1)
}
const AUDIENCE = registry.gameApiAudience
const DID_CLAIM = registry.didClaim
const ACTION_NAME = 'stamp-agent-did'

// ---- management API token ----
const tokenRes = await fetch(`https://${DOMAIN}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: MGMT_ID,
    client_secret: MGMT_SECRET,
    audience: `https://${DOMAIN}/api/v2/`,
  }),
})
if (!tokenRes.ok) {
  console.error(`management token failed: ${tokenRes.status} ${await tokenRes.text()}`)
  process.exit(1)
}
const { access_token } = await tokenRes.json()

async function api(method, path, body, attempt = 0) {
  const res = await fetch(`https://${DOMAIN}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 429 && attempt < 5) {
    const wait = 2 ** attempt * 2000
    console.log(`  (rate limited, retrying in ${wait / 1000}s)`)
    await new Promise((r) => setTimeout(r, wait))
    return api(method, path, body, attempt + 1)
  }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// append an env line to infra/.env immediately unless the key already exists
const envPath = join(ROOT, 'infra/.env')
function envHasKey(key) {
  // match only real assignments at line start — not commented examples
  return new RegExp(`^${key}=`, 'm').test(readFileSync(envPath, 'utf8'))
}
function saveEnvLine(line) {
  if (envHasKey(line.split('=')[0])) return false
  appendFileSync(envPath, `${line}\n`)
  return true
}

// ---- 1. the game API (resource server) ----
const servers = await api('GET', '/resource-servers?per_page=100')
let apiServer = servers.find((s) => s.identifier === AUDIENCE)
if (apiServer) {
  console.log(`✓ API exists: ${AUDIENCE}`)
} else {
  apiServer = await api('POST', '/resource-servers', {
    name: 'codenames-game-engine',
    identifier: AUDIENCE,
    token_lifetime: 3600,
  })
  console.log(`+ created API: ${AUDIENCE}`)
}

// ---- 2 & 3. M2M app + grant per agent ----
// note: listing client_secret would need read:client_keys — we avoid it;
// secrets are only available from the POST response at creation time
const clients = await api('GET', '/clients?per_page=100&fields=client_id,name&include_fields=true')
const grants = await api('GET', `/client-grants?audience=${encodeURIComponent(AUDIENCE)}&per_page=100`)
const didByClientId = {}

for (const agent of [...registry.agents, ...guests]) {
  const appName = `codenames-${agent.name}`
  const prefix = agent.name.toUpperCase().replaceAll('-', '_')
  let client = clients.find((c) => c.name === appName)
  if (client) {
    console.log(`✓ app exists: ${appName} (${client.client_id})`)
    // recover the secret if it's missing from .env (needs read:client_keys)
    if (!envHasKey(`${prefix}_AUTH0_CLIENT_SECRET`)) {
      const full = await api(
        'GET',
        `/clients/${client.client_id}?fields=client_id,client_secret&include_fields=true`,
      )
      client = { ...client, client_secret: full.client_secret }
      console.log(`  recovered secret for ${appName}`)
    }
  } else {
    client = await api('POST', '/clients', {
      name: appName,
      app_type: 'non_interactive',
      grant_types: ['client_credentials'],
    })
    console.log(`+ created app: ${appName} (${client.client_id})`)
  }
  // persist credentials IMMEDIATELY — a later failure must not lose secrets
  saveEnvLine(`${prefix}_AUTH0_CLIENT_ID=${client.client_id}`)
  if (client.client_secret) saveEnvLine(`${prefix}_AUTH0_CLIENT_SECRET=${client.client_secret}`)
  if (!grants.some((g) => g.client_id === client.client_id)) {
    await api('POST', '/client-grants', {
      client_id: client.client_id,
      audience: AUDIENCE,
      scope: [],
    })
    console.log(`  + granted ${appName} → ${AUDIENCE}`)
  }
  if (agent.did) didByClientId[client.client_id] = agent.did
}

// ---- 4. the DID-stamping Action (credentials-exchange flow) ----
const actionCode = `/**
 * Stamps the agent's AT Proto DID onto M2M access tokens.
 * Generated by scripts/setup-auth0.mjs — regenerate rather than hand-edit.
 */
exports.onExecuteCredentialsExchange = async (event, api) => {
  const dids = ${JSON.stringify(didByClientId, null, 2)};
  const did = dids[event.client.client_id];
  if (did) {
    api.accessToken.setCustomClaim('${DID_CLAIM}', did);
  }
};
`
const actions = await api('GET', `/actions/actions?actionName=${ACTION_NAME}`)
let action = actions.actions?.find((a) => a.name === ACTION_NAME)
const actionBody = {
  name: ACTION_NAME,
  code: actionCode,
  supported_triggers: [{ id: 'credentials-exchange', version: 'v2' }],
  runtime: 'node18',
}
if (action) {
  action = await api('PATCH', `/actions/actions/${action.id}`, { code: actionCode })
  console.log(`✓ updated action: ${ACTION_NAME}`)
} else {
  action = await api('POST', '/actions/actions', actionBody)
  console.log(`+ created action: ${ACTION_NAME}`)
}
await api('POST', `/actions/actions/${action.id}/deploy`)
console.log(`  deployed`)

// bind to the credentials-exchange flow (idempotent: set full binding list)
await api('PATCH', '/actions/triggers/credentials-exchange/bindings', {
  bindings: [{ ref: { type: 'action_id', value: action.id }, display_name: ACTION_NAME }],
})
console.log(`  bound to credentials-exchange flow`)

console.log('\ndone — agent credentials are in infra/.env (never printed)')
