#!/usr/bin/env node
/**
 * The guest agent attempts a guess — beat 5 and the live-grant stretch.
 * The guest mints a service-auth token from its OWN foreign PDS (bsky.network)
 * using an app password it created itself — we provision nothing. The token's
 * iss is the guest's DID; the engine's answer depends entirely on FGA tuples.
 *
 * Env: GUEST_AGENT_PDS_PASSWORD — an app password for the guest's account
 *      (create one at bsky.app → Settings → App Passwords).
 *      GUEST_PDS_URL — override the login host (default the bsky.social entryway).
 *
 * Usage: set -a; source infra/.env; set +a
 *        ENGINE_URL=http://localhost:8091 node scripts/guest-move.mjs <gameId> <word>
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintServiceAuth } from './lib/service-auth.mjs'

const [gameId, word] = process.argv.slice(2)
if (!gameId || !word) {
  console.error('usage: node scripts/guest-move.mjs <gameId> <word>')
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const guest = registry.agents.find((a) => a.role === 'guest')
const ENGINE = process.env.ENGINE_URL ?? 'https://game.beckitrue.com'

const token = await mintServiceAuth({
  pds: process.env.GUEST_PDS_URL ?? 'https://bsky.social',
  identifier: guest.handle,
  password: process.env.GUEST_AGENT_PDS_PASSWORD,
  audienceDid: registry.referee.did,
})

console.log(`${guest.handle} (foreign PDS) guesses “${word.toUpperCase()}” on ${gameId}…`)
const res = await fetch(`${ENGINE}/games/${gameId}/guess`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ word }),
})
const body = await res.json()
if (res.status === 200) {
  console.log(`✅ ACCEPTED — the guest is a legal player. One tuple was the whole difference.`)
} else {
  console.log(`⛔ ${res.status} ${body.outcome ?? body.error} — ${body.detail ?? ''}`)
}
