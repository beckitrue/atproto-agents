/**
 * Agent runner CLI (week 2).
 *
 * Planned flow, per agent, per turn:
 *   1. Poll the engine for public game state (or subscribe to the firehose)
 *   2. When it's this agent's turn: pick a move
 *        - brain=llm      → Claude decides (spymaster sees the key via /key)
 *        - brain=scripted → replay a pre-planned move list (demo fallback)
 *   3. Get an Auth0 M2M token (client credentials)
 *   4. POST the move to the engine  ← the FGA-enforced action
 *   5. Write the move record to the agent's own PDS repo (custom lexicon)
 *   6. Post a human-readable mirror to app.bsky.feed.post
 *
 * Usage (planned):
 *   npm run agent -- --name red-spymaster --game demo-1 --brain llm
 */
import { ROSTER } from './config.js'

const name = process.argv.includes('--name')
  ? process.argv[process.argv.indexOf('--name') + 1]
  : undefined

const agent = ROSTER.find((a) => a.name === name)
if (!agent) {
  console.error(`unknown or missing --name; roster: ${ROSTER.map((a) => a.name).join(', ')}`)
  process.exit(1)
}

console.log(`[${agent.name}] ${agent.team} ${agent.role} <${agent.handle}>`)
console.log('agent loop not yet implemented — week 2')
