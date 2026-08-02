/**
 * The agent loop: poll public state → when it's our turn and our phase,
 * decide a move with the brain → POST it (the FGA-enforced action).
 *
 * Week 2 seam: `onMove` fires after each accepted move — that's where the
 * PDS record write + Bluesky mirror post attach.
 */
import type { Team } from '@atproto-agents/lexicon'
import type { Brain, ClueDecision, GuessDecision } from './brain.js'
import type { EngineApi, MoveResult, PublicState } from './engine.js'
import type { Role } from './config.js'

export interface RunnerOptions {
  engine: EngineApi
  brain: Brain
  /** Retried once with this brain if the primary's move is denied by the rules. */
  rulesFallback?: Brain
  agent: { name: string; team: Team; role: Role }
  gameId: string
  pollMs?: number
  /** Deliberate delay before each of OUR moves — paces the game for viewing. */
  paceMs?: number
  log?: (message: string) => void
  onMove?: (move: { kind: 'clue' | 'guess' | 'pass'; decision: ClueDecision | GuessDecision; state: PublicState }) => void | Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Run until the game finishes; returns the final state. */
export async function runAgent(opts: RunnerOptions): Promise<PublicState> {
  const { engine, agent, gameId } = opts
  const pollMs = opts.pollMs ?? 2000
  const paceMs = opts.paceMs ?? 0
  const log = opts.log ?? ((m: string) => console.log(`[${agent.name}] ${m}`))

  let guessesMade = 0
  let clueKey: string | null = null
  let consecutiveDenials = 0

  for (;;) {
    const state = await engine.state(gameId)

    if (state.phase === 'finished') {
      log(`game over: ${state.winner} wins — ${state.winReason}`)
      return state
    }

    // Reset per-clue guess tracking whenever the active clue changes.
    const currentClueKey = state.currentClue ? `${state.currentClue.word}:${state.currentClue.count}` : null
    if (currentClueKey !== clueKey) {
      clueKey = currentClueKey
      guessesMade = 0
    }

    const myMove =
      state.turn === agent.team &&
      ((agent.role === 'spymaster' && state.phase === 'awaiting_clue') ||
        (agent.role === 'operative' && state.phase === 'awaiting_guesses'))

    if (!myMove) {
      await sleep(pollMs)
      continue
    }

    // Pace every move (including back-to-back guesses off one clue) so the demo
    // reads at a human cadence rather than bursting through a turn.
    if (paceMs) await sleep(paceMs)

    const result =
      agent.role === 'spymaster' ? await takeSpymasterTurn(opts, log) : await takeOperativeTurn(opts, state, guessesMade, log)

    if (result.outcome === 'accepted') {
      consecutiveDenials = 0
      if (agent.role === 'operative' && result.state.currentClue) guessesMade++
    } else {
      // Denials are expected system behavior (and demo material) — log and
      // back off, but a well-behaved agent stuck in denials should stop.
      log(`DENIED (${result.outcome}): ${result.detail}`)
      if (++consecutiveDenials >= 5) {
        throw new Error(`${agent.name}: ${consecutiveDenials} consecutive denials — giving up`)
      }
      await sleep(pollMs)
    }
  }
}

async function takeSpymasterTurn(opts: RunnerOptions, log: (m: string) => void): Promise<MoveResult> {
  const { engine, gameId, agent } = opts
  const key = await engine.key(gameId) // can_view_key — spymasters only
  const decide = (brain: Brain) => brain.giveClue({ team: agent.team, key })

  let decision = await decide(opts.brain)
  log(`clue: "${decision.word}" for ${decision.count} — ${decision.reasoning}`)
  let result = await engine.clue(gameId, decision.word, decision.count)

  if (result.outcome === 'denied_rules' && opts.rulesFallback) {
    log(`clue rejected by rules (${result.detail}); retrying with ${opts.rulesFallback.kind}`)
    decision = await decide(opts.rulesFallback)
    result = await engine.clue(gameId, decision.word, decision.count)
  }
  if (result.outcome === 'accepted') await opts.onMove?.({ kind: 'clue', decision, state: result.state })
  return result
}

async function takeOperativeTurn(
  opts: RunnerOptions,
  state: PublicState,
  guessesMade: number,
  log: (m: string) => void,
): Promise<MoveResult> {
  const { engine, gameId, agent } = opts
  const view = { team: agent.team, board: state.board, clue: state.currentClue!, guessesMade }
  const decide = (brain: Brain) => brain.guess(view)

  let decision = await decide(opts.brain)
  const apply = (d: GuessDecision) =>
    d.action === 'pass' ? engine.pass(gameId) : engine.guess(gameId, d.word!)

  log(
    decision.action === 'pass'
      ? `pass — ${decision.reasoning}`
      : `guess: "${decision.word}" — ${decision.reasoning}`,
  )
  let result = await apply(decision)

  if (result.outcome === 'denied_rules' && opts.rulesFallback) {
    log(`guess rejected by rules (${result.detail}); retrying with ${opts.rulesFallback.kind}`)
    decision = await decide(opts.rulesFallback)
    result = await apply(decision)
  }
  if (result.outcome === 'accepted') {
    await opts.onMove?.({ kind: decision.action === 'pass' ? 'pass' : 'guess', decision, state: result.state })
  }
  return result
}
