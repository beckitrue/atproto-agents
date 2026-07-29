#!/usr/bin/env node
/**
 * The guest agent guesses — beat 5 and the live-grant stretch.
 *
 * Two things happen here, and keeping them separate IS the demo:
 *
 *   1. SPEAK. The guest posts a signed com.beckitrue.codenames.guess record —
 *      plus a human-readable Bluesky mirror — to its OWN repo on its OWN
 *      foreign PDS (bsky.network). This needs no permission from us; it
 *      federates to anyone watching. The guest's guess is now public and
 *      permanent whether or not it ever "counts".
 *   2. ACT. The guest mints a service-auth token from that same session and
 *      submits the guess to the engine. Until an FGA tuple grants it a seat,
 *      the answer is 403 denied_authz — voice without authority.
 *
 * So on a denied run you watch the guest say its piece to the whole network
 * and change nothing. Grant one tuple (scripts/grant-guest.mjs) and the very
 * same call is accepted. Speech was always free; authority is the tuple.
 *
 * Env: GUEST_AGENT_PDS_PASSWORD — an app password for the guest's account
 *      (create one at bsky.app → Settings → App Passwords).
 *      GUEST_PDS_URL — override the login host (default the bsky.social entryway).
 *
 * Usage: set -a; source infra/.env; set +a
 *        ENGINE_URL=http://localhost:8091 node scripts/guest-move.mjs <gameId> <word> [--why "..."] [--team red|blue] [--no-speak]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginAgent, tokenFor } from './lib/service-auth.mjs'
import { speakGuess } from './lib/speak.mjs'

// Parse: two positionals (game, word); --why/--team take a value; --no-speak is a switch.
const VALUED = new Set(['--why', '--team'])
const opts = {}
const positional = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--no-speak') opts.noSpeak = true
  else if (VALUED.has(a)) opts[a.slice(2)] = argv[++i]
  else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}`)
    process.exit(1)
  } else positional.push(a)
}
const speak = !opts.noSpeak
const why = opts.why
const teamArg = opts.team
const [gameId, word] = positional
if (!gameId || !word) {
  console.error('usage: node scripts/guest-move.mjs <gameId> <word> [--why "..."] [--team red|blue] [--no-speak]')
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const guest = registry.agents.find((a) => a.role === 'guest')
const ENGINE = process.env.ENGINE_URL ?? 'https://game.beckitrue.com'

// The team the guest is guessing for. Default to whichever team is on the
// clock — public state, no auth needed — so the self-posted record is honest.
let team = teamArg
if (!team) {
  try {
    const state = await (await fetch(`${ENGINE}/games/${gameId}`)).json()
    team = state?.state?.turn ?? state?.turn ?? 'red'
  } catch {
    team = 'red'
  }
}
if (team !== 'red' && team !== 'blue') {
  console.error(`--team must be red or blue (got "${team}")`)
  process.exit(1)
}

// One login to the guest's OWN foreign PDS — used for both speech and token.
const session = await loginAgent({
  pds: process.env.GUEST_PDS_URL ?? 'https://bsky.social',
  identifier: guest.handle,
  password: process.env.GUEST_AGENT_PDS_PASSWORD,
})

// 1. SPEAK — no permission required, federates regardless of the verdict below.
if (speak) {
  const mirror = await speakGuess(session, { game: gameId, team, word, reasoning: why })
  console.log(`🗣️  ${guest.handle} spoke on its OWN repo (federates now):`)
  console.log(mirror.split('\n').map((l) => `      ${l}`).join('\n'))
}

// 2. ACT — the engine decides, based entirely on FGA tuples.
const token = await tokenFor(session, registry.referee.did)
console.log(`\n${guest.handle} (foreign PDS) submits “${word}” to the engine on ${gameId}…`)
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
  if (speak) console.log(`   ↳ voice without authority: the guess above is public and permanent; its effect is nothing.`)
}
