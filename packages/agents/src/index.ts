/**
 * Agent runner CLI.
 *
 * Usage:
 *   npm run agent -- --name red-spymaster --game demo-1 [--brain llm|scripted] [--poll ms]
 *
 * Env (see infra/.env): AUTH0_DOMAIN, AUTH0_AUDIENCE,
 * <PREFIX>_AUTH0_CLIENT_ID/SECRET per agent, GAME_ENGINE_URL,
 * ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL) for --brain llm.
 *
 * TODO(week 2): after each accepted move, write the move record to the
 * agent's own PDS repo and post the Bluesky mirror (runner onMove hook).
 */
import { GAME_ENGINE_URL, ROSTER } from './config.js'
import { ScriptedBrain, withFallback } from './brain.js'
import type { Brain } from './brain.js'
import { LlmBrain } from './llm.js'
import { EngineClient } from './engine.js'
import { tokenProviderFromEnv } from './token.js'
import { runAgent } from './runner.js'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

const name = arg('--name')
const gameId = arg('--game')
const brainKind = arg('--brain') ?? 'llm'

const agent = ROSTER.find((a) => a.name === name)
if (!agent || !gameId) {
  console.error(`usage: npm run agent -- --name <agent> --game <id> [--brain llm|scripted]`)
  console.error(`roster: ${ROSTER.map((a) => a.name).join(', ')}`)
  process.exit(1)
}

// Deterministic per-agent seed so the four fallback players don't mirror each other
const seed = [...agent.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
const scripted = new ScriptedBrain(seed)
let brain: Brain = scripted
if (brainKind === 'llm') {
  brain = withFallback(new LlmBrain(), scripted, (err) =>
    console.error(`[${agent.name}] LLM failed (${err.message}) — falling back to scripted`),
  )
} else if (brainKind !== 'scripted') {
  console.error(`unknown --brain "${brainKind}" (expected llm or scripted)`)
  process.exit(1)
}

const engine = new EngineClient(GAME_ENGINE_URL, tokenProviderFromEnv(agent.envPrefix))

console.log(`[${agent.name}] ${agent.team} ${agent.role} <${agent.handle}> brain=${brain.kind} game=${gameId}`)

runAgent({
  engine,
  brain,
  rulesFallback: scripted,
  agent,
  gameId,
  ...(arg('--poll') ? { pollMs: Number(arg('--poll')) } : {}),
}).catch((err) => {
  console.error(`[${agent.name}] fatal: ${err.message}`)
  process.exit(1)
})
