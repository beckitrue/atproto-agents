#!/usr/bin/env node
/**
 * Make any roster agent attempt any action RIGHT NOW — bypassing the
 * well-behaved runner. This is the demo-beat driver: off-turn clues,
 * key-card peeks, spymasters trying to guess. The engine's answer is
 * the show.
 *
 * Usage: set -a; source infra/.env; set +a
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> clue <word> <count>
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> guess <word>
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> pass
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> key
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, gameId, action, word, count] = process.argv.slice(2)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const agent = registry.agents.find((a) => a.name === name)
if (!agent || !gameId || !['clue', 'guess', 'pass', 'key'].includes(action ?? '')) {
  console.error('usage: node scripts/rogue-move.mjs <agent> <game> clue|guess|pass|key [word] [count]')
  console.error(`agents: ${registry.agents.map((a) => a.name).join(', ')}`)
  process.exit(1)
}

const ENGINE = process.env.ENGINE_URL ?? 'https://game.beckitrue.com'
const prefix = name.toUpperCase().replaceAll('-', '_')
const tok = await (
  await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env[`${prefix}_AUTH0_CLIENT_ID`],
      client_secret: process.env[`${prefix}_AUTH0_CLIENT_SECRET`],
      audience: registry.gameApiAudience,
    }),
  })
).json()
const auth = { authorization: `Bearer ${tok.access_token}` }

let res
if (action === 'key') {
  console.log(`${name} requests the key card for ${gameId}…`)
  res = await fetch(`${ENGINE}/games/${gameId}/key`, { headers: auth })
} else {
  const body = action === 'clue' ? { word, count: Number(count ?? 1) } : action === 'guess' ? { word } : {}
  console.log(`${name} attempts ${action}${word ? ` “${word.toUpperCase()}”` : ''} on ${gameId}…`)
  res = await fetch(`${ENGINE}/games/${gameId}/${action}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const body = await res.json()
if (res.status === 200) {
  console.log(action === 'key' ? `✅ 200 — the key card (spymasters only):` : `✅ 200 accepted`)
  if (action === 'key') {
    const rows = body.key.map((c) => `${c.word}:${c.cardType}`)
    for (let i = 0; i < 25; i += 5) console.log('   ' + rows.slice(i, i + 5).join('  '))
  }
} else {
  console.log(`⛔ ${res.status} ${body.outcome ?? body.error} — ${body.detail ?? body.code ?? ''}`)
}
