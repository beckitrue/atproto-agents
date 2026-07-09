#!/usr/bin/env node
/**
 * Kill switch, Auth0 layer: delete an agent's client grant so it can no
 * longer mint tokens for the game API. Already-issued tokens stay valid
 * until expiry (token_lifetime, 1h) — revoke FGA tuples first for
 * immediate effect (scripts/grant-guest.mjs --revoke, or delete the
 * agent's standing role tuples).
 *
 * Restore = re-run scripts/setup-auth0.mjs (idempotent; recreates the grant).
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/revoke-agent.mjs <agent-name>   # e.g. guest-agent
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = process.argv[2]
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
if (!name || !registry.agents.some((a) => a.name === name)) {
  console.error(`usage: node scripts/revoke-agent.mjs <agent-name>`)
  console.error(`agents: ${registry.agents.map((a) => a.name).join(', ')}`)
  process.exit(1)
}

const DOMAIN = process.env.AUTH0_DOMAIN
const { access_token } = await (
  await fetch(`https://${DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.AUTH0_MGMT_CLIENT_ID,
      client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET,
      audience: `https://${DOMAIN}/api/v2/`,
    }),
  })
).json()

const api = async (method, path) => {
  const res = await fetch(`https://${DOMAIN}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${access_token}` },
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

const clients = await api('GET', '/clients?per_page=100&fields=client_id,name&include_fields=true')
const client = clients.find((c) => c.name === `codenames-${name}`)
if (!client) {
  console.error(`no Auth0 app named codenames-${name}`)
  process.exit(1)
}

const audience = encodeURIComponent(registry.gameApiAudience)
const grants = await api('GET', `/client-grants?audience=${audience}&per_page=100`)
const grant = grants.find((g) => g.client_id === client.client_id)
if (!grant) {
  console.log(`✓ ${name} already has no grant for ${registry.gameApiAudience} — nothing to revoke`)
  process.exit(0)
}

await api('DELETE', `/client-grants/${grant.id}`)
console.log(`🔒 REVOKED: ${name} can no longer mint tokens for ${registry.gameApiAudience}`)
console.log(`   (tokens issued in the last hour remain valid until expiry — also revoke`)
console.log(`    FGA tuples for immediate effect: node scripts/grant-guest.mjs <game> --revoke)`)
console.log(`   restore: node scripts/setup-auth0.mjs`)
