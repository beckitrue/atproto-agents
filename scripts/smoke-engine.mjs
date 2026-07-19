#!/usr/bin/env node
/**
 * Live smoke test: the demo beats against the REAL Auth0 tenant and FGA store.
 *
 * What it proves end to end:
 *   - Auth0 M2M tokens carry the DID custom claim (the Action works)
 *   - the engine verifies tokens and maps DID → FGA user
 *   - FGA allows/denies per the model, and turn transitions move real tuples
 *
 * Requires the engine running locally against the same env.
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

async function auth0Token(agentName) {
  const prefix = agentName.toUpperCase().replaceAll('-', '_')
  const clientId = process.env[`${prefix}_AUTH0_CLIENT_ID`]
  const clientSecret = process.env[`${prefix}_AUTH0_CLIENT_SECRET`]
  if (!clientId || !clientSecret) throw new Error(`missing Auth0 creds for ${agentName} in env`)
  const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: registry.gameApiAudience,
    }),
  })
  if (!res.ok) throw new Error(`token for ${agentName}: ${res.status} ${await res.text()}`)
  return (await res.json()).access_token
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

// ---- get real tokens (also proves the DID-stamping Action fires) ----
console.log('fetching Auth0 tokens (client credentials, real tenant)…')
const tokens = {}
for (const name of ['red-spymaster', 'red-operative', 'blue-spymaster', 'blue-operative', 'guest-agent']) {
  tokens[name] = await auth0Token(name)
}
console.log('  got 5 tokens')

// quick claim sanity check without verifying (the engine does that part)
const claim = JSON.parse(Buffer.from(tokens['red-spymaster'].split('.')[1], 'base64url').toString())[
  registry.didClaim
]
check('red-spymaster token carries the DID claim', claim === agentByRole('red', 'spymaster').did, claim)

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

console.log(`\nbeat 5 — guest agent: authenticated by Auth0, holds nothing`)
res = await api('POST', `/games/${GAME}/guess`, tokens['guest-agent'], { word: 'ANCHOR' })
const guestHasDid = Boolean(agentByRole(null, 'guest')?.did)
if (guestHasDid) {
  check('denied_authz (voice, not authority)', res.status === 403 && res.body.outcome === 'denied_authz')
} else {
  // guest has no DID yet (foreign-PDS identity pending) → the Action stamps no
  // claim and the engine refuses at authentication. Becomes 403 once it exists.
  check('401 unauthenticated (no DID claim yet — expected until foreign identity exists)', res.status === 401, res.body.detail)
}

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
