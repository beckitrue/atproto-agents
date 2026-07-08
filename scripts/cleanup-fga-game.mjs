#!/usr/bin/env node
/**
 * Delete a finished game's FGA tuples so the dashboard stays clean.
 * Deletes the four standing role tuples (active tuples are revoked by the
 * engine at game end; pass --active <team> if the game did not finish).
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/cleanup-fga-game.mjs <gameId> [--active red|blue]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gameId = process.argv[2]
if (!gameId) {
  console.error('usage: node scripts/cleanup-fga-game.mjs <gameId> [--active red|blue]')
  process.exit(1)
}
const activeIdx = process.argv.indexOf('--active')
const activeTeam = activeIdx === -1 ? null : process.argv[activeIdx + 1]

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const byRole = (t, r) => registry.agents.find((a) => a.team === t && a.role === r).did
const fgaUser = (did) => `agent:${did.replaceAll(':', '_')}`

const tokRes = await fetch(`https://${process.env.FGA_API_TOKEN_ISSUER ?? 'auth.fga.dev'}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: process.env.FGA_CLIENT_ID,
    client_secret: process.env.FGA_CLIENT_SECRET,
    audience: process.env.FGA_API_AUDIENCE ?? 'https://api.us1.fga.dev/',
  }),
})
const { access_token } = await tokRes.json()

const object = `game:${gameId}`
const deletes = [
  { user: fgaUser(byRole('red', 'spymaster')), relation: 'spymaster_red', object },
  { user: fgaUser(byRole('red', 'operative')), relation: 'operative_red', object },
  { user: fgaUser(byRole('blue', 'spymaster')), relation: 'spymaster_blue', object },
  { user: fgaUser(byRole('blue', 'operative')), relation: 'operative_blue', object },
  ...(activeTeam
    ? [
        { user: fgaUser(byRole(activeTeam, 'spymaster')), relation: 'active_clue_giver', object },
        { user: fgaUser(byRole(activeTeam, 'operative')), relation: 'active_guesser', object },
      ]
    : []),
]

const apiUrl = process.env.FGA_API_URL ?? 'https://api.us1.fga.dev'
const res = await fetch(`${apiUrl}/stores/${process.env.FGA_STORE_ID}/write`, {
  method: 'POST',
  headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ deletes: { tuple_keys: deletes } }),
})
console.log(res.ok ? `deleted ${deletes.length} tuples for ${object}` : `failed: ${res.status} ${await res.text()}`)
process.exit(res.ok ? 0 : 1)
