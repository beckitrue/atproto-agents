#!/usr/bin/env node
/**
 * Create a game with the standard roster. The operator's action (demo driver).
 *
 * Usage: set -a; source infra/.env; set +a
 *        ENGINE_URL=... node scripts/new-game.mjs <gameId> [seed]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [gameId, seedArg] = process.argv.slice(2)
if (!gameId) {
  console.error('usage: node scripts/new-game.mjs <gameId> [seed]')
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const byRole = (t, r) => registry.agents.find((a) => a.team === t && a.role === r).did
const ENGINE = process.env.ENGINE_URL ?? 'https://game.beckitrue.com'

const res = await fetch(`${ENGINE}/games`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: gameId,
    ...(seedArg ? { seed: Number(seedArg) } : {}),
    roles: {
      spymasterRed: byRole('red', 'spymaster'),
      operativeRed: byRole('red', 'operative'),
      spymasterBlue: byRole('blue', 'spymaster'),
      operativeBlue: byRole('blue', 'operative'),
    },
  }),
})
const body = await res.json()
if (!res.ok) {
  console.error(`create failed: ${res.status} ${JSON.stringify(body)}`)
  process.exit(1)
}
console.log(`🎲 game ${gameId} created — ${body.state.turn.toUpperCase()} goes first`)
