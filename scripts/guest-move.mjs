#!/usr/bin/env node
/**
 * The guest agent attempts a guess — beat 5 and the live-grant stretch.
 * Authenticates with the guest's real Auth0 client (token carries its
 * foreign-PDS DID); the engine's answer depends entirely on FGA tuples.
 *
 * Usage: set -a; source infra/.env; set +a
 *        ENGINE_URL=http://localhost:8091 node scripts/guest-move.mjs <gameId> <word>
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [gameId, word] = process.argv.slice(2)
if (!gameId || !word) {
  console.error('usage: node scripts/guest-move.mjs <gameId> <word>')
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const guest = registry.agents.find((a) => a.role === 'guest')
const ENGINE = process.env.ENGINE_URL ?? 'https://game.beckitrue.com'

const tok = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: process.env.GUEST_AGENT_AUTH0_CLIENT_ID,
    client_secret: process.env.GUEST_AGENT_AUTH0_CLIENT_SECRET,
    audience: registry.gameApiAudience,
  }),
}).then((r) => r.json())

console.log(`${guest.handle} (foreign PDS) guesses “${word.toUpperCase()}” on ${gameId}…`)
const res = await fetch(`${ENGINE}/games/${gameId}/guess`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ word }),
})
const body = await res.json()
if (res.status === 200) {
  console.log(`✅ ACCEPTED — the guest is a legal player. One tuple was the whole difference.`)
} else {
  console.log(`⛔ ${res.status} ${body.outcome ?? body.error} — ${body.detail ?? ''}`)
}
