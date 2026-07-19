#!/usr/bin/env node
/**
 * THE ON-STAGE MOMENT: grant (or revoke) the guest agent's turn tuple.
 * One tuple is the entire difference between "rogue whose posts have no
 * effect" and "welcome player" — same mechanism as inviting anyone's agent.
 *
 * The engine's turn transitions only touch roster holders, so a guest
 * grant persists across turns until you revoke it.
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/grant-guest.mjs <gameId>              # the registry guest
 *        node scripts/grant-guest.mjs <gameId> --did <did>  # any approved guest
 *        node scripts/grant-guest.mjs <gameId> --revoke     # take it back
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gameId = process.argv[2]
const revoke = process.argv.includes('--revoke')
if (!gameId) {
  console.error('usage: node scripts/grant-guest.mjs <gameId> [--revoke]')
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const didIdx = process.argv.indexOf('--did')
const guest =
  didIdx !== -1
    ? { did: process.argv[didIdx + 1], handle: process.argv[didIdx + 1] }
    : registry.agents.find((a) => a.role === 'guest')
if (!guest?.did?.startsWith('did:')) {
  console.error('no guest DID (registry guest missing, or bad --did value)')
  process.exit(1)
}

const tuple = {
  user: `agent:${guest.did.replaceAll(':', '_')}`,
  relation: 'active_guesser',
  object: `game:${gameId}`,
}
const res = await fetch(
  `${process.env.FGA_API_URL ?? 'http://localhost:8080'}/stores/${process.env.FGA_STORE_ID}/write`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(revoke ? { deletes: { tuple_keys: [tuple] } } : { writes: { tuple_keys: [tuple] } }),
  },
)
if (!res.ok) {
  console.error(`FGA write failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
console.log(
  revoke
    ? `🔒 REVOKED: ${guest.handle} no longer holds active_guesser on game:${gameId}`
    : `🔑 GRANTED: ${guest.handle} (${guest.did}) now holds active_guesser on game:${gameId}`,
)
