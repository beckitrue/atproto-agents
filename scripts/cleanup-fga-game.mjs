#!/usr/bin/env node
/**
 * Delete a game's FGA tuples so the dashboard stays clean for the show.
 *
 * Reads the tuples that actually exist on the game and deletes those, so it
 * needs no hints about how the game ended — the old `--active red|blue` flag
 * is gone, and passing it is no longer necessary (or accepted).
 *
 * Idempotent: running it twice, or on a game with no tuples, succeeds.
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/cleanup-fga-game.mjs <gameId> [<gameId>…]
 *        node scripts/cleanup-fga-game.mjs --dry-run <gameId>
 */
import { deleteGameTuples, fgaToken, readGameTuples, reportCleanup } from './fga-tuples.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const gameIds = args.filter((a) => !a.startsWith('--'))

if (gameIds.length === 0) {
  console.error('usage: node scripts/cleanup-fga-game.mjs [--dry-run] <gameId> [<gameId>…]')
  process.exit(1)
}
if (args.includes('--active')) {
  console.error('--active is no longer needed: the script reads the tuples that exist.')
  process.exit(1)
}

const token = await fgaToken()
let ok = true

for (const gameId of gameIds) {
  if (dryRun) {
    const tuples = await readGameTuples(token, gameId)
    console.log(`  game:${gameId} — ${tuples.length} tuple(s)`)
    for (const t of tuples) console.log(`    ${t.relation.padEnd(20)} ${t.user}`)
    continue
  }
  ok = reportCleanup(gameId, await deleteGameTuples(token, gameId)) && ok
}

process.exit(ok ? 0 : 1)
