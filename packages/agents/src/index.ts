/**
 * Agent runner CLI.
 *
 * Usage:
 *   npm run agent -- --name red-spymaster --game demo-1 [--brain llm|scripted] [--poll ms]
 *
 * Env (see infra/.env): <PREFIX>_PDS_PASSWORD per agent (the agent logs into
 * its PDS to mint AT Proto service-auth tokens), GAME_ENGINE_URL, PDS_URL,
 * optional ENGINE_DID (token audience), ANTHROPIC_API_KEY (+ optional
 * ANTHROPIC_MODEL) for --brain llm.
 *
 * That same PDS login also publishes every accepted move to the agent's own
 * repo: a custom lexicon record + a Bluesky mirror post with the reasoning.
 * Disable posting with --no-post (authentication still uses the login).
 */
import { GAME_ENGINE_URL, PDS_URL, ROSTER } from './config.js'
import type { AgentConfig } from './config.js'
import { MovePoster } from './poster.js'
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
  const llm = new LlmBrain({
    // PRIVATE thinking — local terminal only (spymaster thinking sees the key)
    onThinking: (t) => console.log(`[${agent.name}] 🧠 ${t.replaceAll('\n', ' ').slice(0, 500)}`),
  })
  brain = withFallback(llm, scripted, (err) =>
    console.error(`[${agent.name}] LLM failed (${err.message}) — falling back to scripted`),
  )
} else if (brainKind !== 'scripted') {
  console.error(`unknown --brain "${brainKind}" (expected llm or scripted)`)
  process.exit(1)
}

const engine = new EngineClient(GAME_ENGINE_URL, tokenProviderFromEnv(agent))

const pdsPassword = process.env[`${agent.envPrefix}_PDS_PASSWORD`]
const posting = Boolean(pdsPassword) && !process.argv.includes('--no-post')
const poster = posting
  ? new MovePoster({
      service: PDS_URL,
      handle: agent.handle,
      password: pdsPassword!,
      team: agent.team,
      log: (m) => console.log(`[${agent.name}] 📡 ${m}`),
    })
  : null

console.log(
  `[${agent.name}] ${agent.team} ${agent.role} <${agent.handle}> brain=${brain.kind} game=${gameId} posting=${posting}`,
)

async function main(who: AgentConfig, game: string) {
  await poster?.login()
  await runAgent({
    engine,
    brain,
    rulesFallback: scripted,
    agent: who,
    gameId: game,
    ...(arg('--poll') ? { pollMs: Number(arg('--poll')) } : {}),
    // Speech is free — but never let a PDS hiccup stall the game itself.
    onMove: async (move) => {
      try {
        await poster?.postMove(move)
      } catch (err) {
        console.error(`[${who.name}] PDS post failed: ${(err as Error).message}`)
      }
    },
  })
}

main(agent, gameId).catch((err) => {
  console.error(`[${agent.name}] fatal: ${err.message}`)
  process.exit(1)
})
