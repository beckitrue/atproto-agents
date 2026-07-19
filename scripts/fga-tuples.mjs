/**
 * Shared FGA tuple helpers for the operator scripts.
 *
 * Cleanup used to PREDICT which tuples a game had — deriving the active
 * holders from the current turn, or taking `--active red|blue` on trust —
 * and then issue one atomic delete. Two ways that breaks:
 *
 *   1. A wrong prediction fails the ENTIRE batch, since an FGA write is
 *      atomic and errors on deleting a tuple that doesn't exist.
 *   2. Worse, a RIGHT prediction fails too if the tuple was written moments
 *      ago: FGA is eventually consistent, and the write path's existence
 *      check can still be looking at stale data. This is the same race that
 *      forced HIGHER_CONSISTENCY on the engine's checks.
 *
 * So: read the tuples that actually exist, delete exactly those, and treat
 * "does not exist" as success — cleanup is idempotent by definition.
 */

const FGA_API_URL = () => process.env.FGA_API_URL ?? 'https://api.us1.fga.dev'

export async function fgaToken() {
  const issuer = process.env.FGA_API_TOKEN_ISSUER ?? 'auth.fga.dev'
  const res = await fetch(`https://${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.FGA_CLIENT_ID,
      client_secret: process.env.FGA_CLIENT_SECRET,
      audience: process.env.FGA_API_AUDIENCE ?? 'https://api.us1.fga.dev/',
    }),
  })
  if (!res.ok) throw new Error(`FGA token request failed: ${res.status} ${await res.text()}`)
  const { access_token } = await res.json()
  if (!access_token) throw new Error('FGA token response carried no access_token')
  return access_token
}

const call = async (token, path, body) =>
  fetch(`${FGA_API_URL()}/stores/${process.env.FGA_STORE_ID}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Every tuple currently on `game:<id>`, following pagination. */
export async function readGameTuples(token, gameId) {
  const object = `game:${gameId}`
  const tuples = []
  let continuation_token
  do {
    const res = await call(token, '/read', {
      tuple_key: { object },
      ...(continuation_token ? { continuation_token } : {}),
    })
    if (!res.ok) throw new Error(`FGA read failed: ${res.status} ${await res.text()}`)
    const body = await res.json()
    for (const t of body.tuples ?? []) {
      const { user, relation, object: obj } = t.key
      tuples.push({ user, relation, object: obj })
    }
    continuation_token = body.continuation_token || undefined
  } while (continuation_token)
  return tuples
}

const MISSING = /does not exist|did not exist/i

/**
 * Delete every tuple on a game. Idempotent: deleting nothing is success.
 *
 * `settleMs` waits before reading, so tuples written moments earlier (the
 * end of a smoke run) are visible. If the batch delete still loses the race,
 * fall back to deleting one at a time so one stale tuple can't strand the
 * other five.
 */
export async function deleteGameTuples(token, gameId, { settleMs = 0 } = {}) {
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs))

  const tuples = await readGameTuples(token, gameId)
  if (tuples.length === 0) return { deleted: 0, alreadyGone: 0, failed: [] }

  const batch = await call(token, '/write', { deletes: { tuple_keys: tuples } })
  if (batch.ok) return { deleted: tuples.length, alreadyGone: 0, failed: [] }

  // Atomic batch lost the race; retry individually so partial success sticks.
  let deleted = 0
  let alreadyGone = 0
  const failed = []
  for (const t of tuples) {
    const one = await call(token, '/write', { deletes: { tuple_keys: [t] } })
    if (one.ok) {
      deleted++
      continue
    }
    const text = await one.text()
    if (MISSING.test(text)) alreadyGone++
    else failed.push({ tuple: t, error: `${one.status} ${text}` })
  }
  return { deleted, alreadyGone, failed }
}

/** Human summary; also the exit-code decision. */
export function reportCleanup(gameId, { deleted, alreadyGone, failed }) {
  const bits = [`${deleted} deleted`]
  if (alreadyGone) bits.push(`${alreadyGone} already gone`)
  if (failed.length) bits.push(`${failed.length} FAILED`)
  console.log(`  game:${gameId} — ${bits.join(', ')}`)
  for (const f of failed) console.log(`    ${f.tuple.relation} ${f.tuple.user}: ${f.error}`)
  return failed.length === 0
}
