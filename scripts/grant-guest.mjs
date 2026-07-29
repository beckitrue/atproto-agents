#!/usr/bin/env node
/**
 * THE ON-STAGE MOMENT: grant (or revoke) the guest agent's turn tuple.
 * One tuple is the entire difference between "rogue whose posts have no
 * effect" and "welcome player" — same mechanism as inviting anyone's agent.
 *
 * The engine's turn transitions only touch roster holders, so a guest
 * grant persists across turns until you revoke it.
 *
 * Prints the game's FGA tuples before → after the write (+ added, - removed),
 * so the authority change is visible on stage — OpenFGA has no hosted UI.
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

const FGA = process.env.FGA_API_URL ?? 'http://localhost:8080'
const STORE = process.env.FGA_STORE_ID

const tuple = {
  user: `agent:${guest.did.replaceAll(':', '_')}`,
  relation: 'active_guesser',
  object: `game:${gameId}`,
}

/** All FGA tuples on this game — the authority layer, laid bare for the stage. */
async function readGameTuples() {
  const res = await fetch(`${FGA}/stores/${STORE}/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tuple_key: { object: `game:${gameId}` } }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const { tuples } = await res.json()
  return (tuples ?? []).map((t) => t.key)
}

/** Print the tuple set as a before → after diff: + added, - removed. */
function printDiff(before, after) {
  const key = (k) => `${k.relation}  ${k.user}`
  const b = new Set(before.map(key))
  const a = new Set(after.map(key))
  const rows = [...new Set([...b, ...a])].sort()
  console.log(`\ntuples on game:${gameId}  (before → after):`)
  if (rows.length === 0) {
    console.log('   (none)')
    return
  }
  for (const row of rows) {
    const mark = b.has(row) && a.has(row) ? '   ' : a.has(row) ? ' + ' : ' - '
    console.log(`${mark}${row}`)
  }
}

// Read the game's tuples before the write — non-fatal if FGA can't be reached
// for a read (the write below will surface a real connectivity problem).
let before = []
try {
  before = await readGameTuples()
} catch (err) {
  console.error(`(couldn't read tuples before the write: ${err.message})`)
}

let res
try {
  res = await fetch(`${FGA}/stores/${STORE}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(revoke ? { deletes: { tuple_keys: [tuple] } } : { writes: { tuple_keys: [tuple] } }),
  })
} catch (err) {
  console.error(`FGA unreachable at ${FGA}: ${err.message}`)
  console.error(`(OpenFGA is internal-only on the box — set FGA_API_URL/FGA_STORE_ID to a reachable store; see docs/DEMO-RUNBOOK.md pre-flight)`)
  process.exit(1)
}
if (!res.ok) {
  console.error(`FGA write failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
console.log(
  revoke
    ? `🔒 REVOKED: ${guest.handle} no longer holds active_guesser on game:${gameId}`
    : `🔑 GRANTED: ${guest.handle} (${guest.did}) now holds active_guesser on game:${gameId}`,
)

try {
  printDiff(before, await readGameTuples())
} catch (err) {
  console.error(`(couldn't read tuples after the write: ${err.message})`)
}
