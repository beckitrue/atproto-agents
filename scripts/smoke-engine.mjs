#!/usr/bin/env node
/**
 * Live smoke test: the demo beats against the REAL PDS(es) and FGA store.
 *
 * What it proves end to end:
 *   - each agent mints a service-auth token from its own PDS (iss = its DID)
 *   - the engine verifies tokens via DID resolution and maps DID → FGA user
 *   - FGA allows/denies per the model, and turn transitions move real tuples
 *
 * Requires the engine running locally against the same env, plus each agent's
 * <PREFIX>_PDS_PASSWORD (roster agents) and GUEST_AGENT_PDS_PASSWORD (guest).
 * Usage:
 *   set -a; source infra/.env; set +a
 *   ENGINE_URL=http://localhost:8091 node scripts/smoke-engine.mjs
 *
 * Cleans up the FGA tuples it created (unique game id per run).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deleteGameTuples, fgaToken, reportCleanup } from './fga-tuples.mjs'
import { mintServiceAuth } from './lib/service-auth.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const ENGINE = process.env.ENGINE_URL ?? 'http://localhost:8080'
const GAME = `smoke-${Date.now()}`

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const agentByRole = (team, role) => registry.agents.find((a) => a.team === team && a.role === role)

async function serviceAuthToken(agentName) {
  const agent = registry.agents.find((a) => a.name === agentName)
  if (!agent) throw new Error(`unknown agent ${agentName}`)
  const prefix = agentName.toUpperCase().replaceAll('-', '_')
  const password = process.env[`${prefix}_PDS_PASSWORD`]
  if (!password) throw new Error(`missing ${prefix}_PDS_PASSWORD for ${agentName} in env`)
  // The guest lives on a foreign PDS (bsky.network); roster agents on ours.
  const pds =
    agent.role === 'guest'
      ? process.env.GUEST_PDS_URL ?? 'https://bsky.social'
      : process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN ?? 'beckitrue.com'}`
  return mintServiceAuth({ pds, identifier: agent.handle, password, audienceDid: registry.referee.did })
}

async function api(method, path, token, body) {
  const res = await fetch(`${ENGINE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json() }
}

// ---- get real tokens (each agent signs its own, from its own PDS) ----
console.log('minting service-auth tokens (each agent signs with its own repo key)…')
const tokens = {}
for (const name of ['red-spymaster', 'red-operative', 'blue-spymaster', 'blue-operative', 'guest-agent']) {
  tokens[name] = await serviceAuthToken(name)
}
console.log('  got 5 tokens')

// sanity check without verifying (the engine does that part): iss is the
// agent's own DID, aud is the engine's DID.
const claims = JSON.parse(Buffer.from(tokens['red-spymaster'].split('.')[1], 'base64url').toString())
check('red-spymaster token iss is its own DID', claims.iss === agentByRole('red', 'spymaster').did, claims.iss)
check('token aud is the engine DID', claims.aud === registry.referee.did, claims.aud)

// ---- create the game ----
const roles = {
  spymasterRed: agentByRole('red', 'spymaster').did,
  operativeRed: agentByRole('red', 'operative').did,
  spymasterBlue: agentByRole('blue', 'spymaster').did,
  operativeBlue: agentByRole('blue', 'operative').did,
}
console.log(`\ncreating game ${GAME} (writes real FGA tuples)…`)
const created = await api('POST', '/games', null, { id: GAME, roles, seed: 1 })
check('game created', created.status === 200, `turn: ${created.body.state?.turn}`)
const first = created.body.state.turn // seeded, but read it rather than assume
const second = first === 'red' ? 'blue' : 'red'
const tokenFor = (team, role) => tokens[agentByRole(team, role).name]

// ---- the beats ----
console.log(`\nbeat 1 — on-turn clue (${first} spymaster) → allowed`)
let res = await api('POST', `/games/${GAME}/clue`, tokenFor(first, 'spymaster'), { word: 'nebula', count: 2 })
check('accepted', res.status === 200 && res.body.outcome === 'accepted', JSON.stringify(res.body.currentClue ?? res.body.state?.currentClue))

console.log(`\nbeat 2 — off-turn clue (${second} spymaster) → denied by FGA`)
res = await api('POST', `/games/${GAME}/clue`, tokenFor(second, 'spymaster'), { word: 'sneaky', count: 3 })
check('denied_authz', res.status === 403 && res.body.outcome === 'denied_authz', res.body.detail)

console.log(`\nbeat 3 — operative requests the key → denied; spymaster → allowed`)
res = await api('GET', `/games/${GAME}/key`, tokenFor(first, 'operative'))
check('operative denied', res.status === 403 && res.body.outcome === 'denied_authz')
res = await api('GET', `/games/${GAME}/key`, tokenFor(first, 'spymaster'))
check('spymaster allowed', res.status === 200 && res.body.key?.length === 25)

console.log(`\nbeat 4 — ${first} spymaster (knows the key) tries to guess → denied`)
res = await api('POST', `/games/${GAME}/guess`, tokenFor(first, 'spymaster'), { word: 'ANCHOR' })
check('denied_authz (separation of duties)', res.status === 403 && res.body.outcome === 'denied_authz')

console.log(`\nbeat 5 — guest agent: authenticated by its own foreign PDS, holds nothing`)
res = await api('POST', `/games/${GAME}/guess`, tokens['guest-agent'], { word: 'ANCHOR' })
check('denied_authz (voice, not authority)', res.status === 403 && res.body.outcome === 'denied_authz')

console.log(`\nturn transition — ${first} operative passes; authority moves to ${second} (real tuple writes)`)
res = await api('POST', `/games/${GAME}/pass`, tokenFor(first, 'operative'))
check('pass accepted', res.status === 200 && res.body.state?.turn === second)
res = await api('POST', `/games/${GAME}/clue`, tokenFor(second, 'spymaster'), { word: 'nebula', count: 1 })
check(`${second} spymaster can now clue`, res.status === 200 && res.body.outcome === 'accepted')
res = await api('POST', `/games/${GAME}/clue`, tokenFor(first, 'spymaster'), { word: 'late', count: 1 })
check(`${first} spymaster lost the authority`, res.status === 403 && res.body.outcome === 'denied_authz')

// ---- audit trail ----
const events = await api('GET', `/games/${GAME}/events`, null)
console.log('\naudit trail:')
for (const e of events.body.events) {
  console.log(`  ${e.at}  ${e.kind.padEnd(10)} ${e.outcome.padEnd(13)} ${e.actor}${e.detail ? `  (${e.detail})` : ''}`)
}

// ---- FGA cleanup: remove this run's tuples ----
console.log('\ncleaning up FGA tuples…')
try {
  // Settle first: the engine wrote turn tuples milliseconds ago, and FGA is
  // eventually consistent — deleting them immediately can fail claiming they
  // don't exist. The helper reads what's really there and is idempotent.
  const token = await fgaToken()
  reportCleanup(GAME, await deleteGameTuples(token, GAME, { settleMs: 1500 }))
} catch (err) {
  console.log(`  cleanup skipped: ${err.message}`)
}

console.log(failures === 0 ? '\nSMOKE PASSED' : `\nSMOKE FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
