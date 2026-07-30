#!/usr/bin/env node
/**
 * Make any roster agent attempt any action RIGHT NOW — bypassing the
 * well-behaved runner. This is the demo-beat driver: off-turn clues,
 * key-card peeks, spymasters trying to guess. The engine's answer is
 * the show.
 *
 * SPEAK FIRST, THEN ACT. For clue/guess the agent writes the move to its OWN
 * repo before asking the engine — because that is the whole thesis: records
 * are speech and need nobody's permission, FGA is authority and decides what
 * counts. Without this the firehose only ever carries the referee's denial,
 * so the audience sees us narrate the refusal but never sees the accused say
 * anything. Now both sides are signed and independently verifiable: the
 * rogue's claim in its repo, the referee's ruling in ours.
 *
 * (pass/key never speak: a key-card peek is a read, not an utterance.)
 *
 * Usage: set -a; source infra/.env; set +a
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> clue <word> <count> [--why "…"]
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> guess <word> [--why "…"]
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> pass
 *        ENGINE_URL=... node scripts/rogue-move.mjs <agent> <game> key
 *        --no-speak  skip the repo write and only hit the engine (old behaviour)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginAgent, tokenFor } from './lib/service-auth.mjs'
import { speakClue, speakGuess } from './lib/speak.mjs'

// Parse: positionals in order, --why takes a value, --no-speak is a switch.
const argv = process.argv.slice(2)
const positional = []
const opts = {}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--why') opts.why = argv[++i]
  else if (a === '--no-speak') opts.speak = false
  else positional.push(a)
}
const [name, gameId, action, word, count] = positional
const speak = opts.speak !== false

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const agent = registry.agents.find((a) => a.name === name)
if (!agent || !gameId || !['clue', 'guess', 'pass', 'key'].includes(action ?? '')) {
  console.error(
    'usage: node scripts/rogue-move.mjs <agent> <game> clue|guess|pass|key [word] [count] [--why "…"] [--no-speak]',
  )
  console.error(`agents: ${registry.agents.map((a) => a.name).join(', ')}`)
  process.exit(1)
}

const ENGINE = process.env.ENGINE_URL ?? 'https://game.beckitrue.com'
const prefix = name.toUpperCase().replaceAll('-', '_')
// One login serves both halves: the repo write (speech) and the service-auth
// token (authority proof). See scripts/lib/service-auth.mjs.
const session = await loginAgent({
  pds: process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN ?? 'beckitrue.com'}`,
  identifier: agent.handle,
  password: process.env[`${prefix}_PDS_PASSWORD`],
})

// 1. SPEAK — no permission required, federates regardless of the verdict below.
if (speak && (action === 'clue' || action === 'guess')) {
  const said =
    action === 'clue'
      ? await speakClue(session, {
          game: gameId,
          team: agent.team,
          word,
          count: Number(count ?? 1),
          reasoning: opts.why,
        })
      : await speakGuess(session, { game: gameId, team: agent.team, word, reasoning: opts.why })
  console.log(`🗣️  ${agent.handle} spoke on its OWN repo (federates now, nobody approved it):`)
  console.log(said.text.split('\n').map((l) => `      ${l}`).join('\n'))
  console.log(`   ↳ record: ${said.uri}`)
  console.log(`   ↳ verify: node scripts/verify-record.mjs ${said.uri}\n`)
}

// 2. ACT — the engine decides, based entirely on FGA tuples.
const token = await tokenFor(session, registry.referee.did)
const auth = { authorization: `Bearer ${token}` }

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
  if (speak && (action === 'clue' || action === 'guess')) {
    console.log(`   (the record above still stands — speech federated, the move did not count)`)
  }
}
