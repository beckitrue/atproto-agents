/**
 * Transparent communication: after every accepted move, the agent writes
 * to its OWN repo — nobody else can speak for it, and everything it says
 * is public and signed:
 *
 *   1. A structured com.beckitrue.codenames.* record — the machine-readable
 *      agent-to-agent channel (custom lexicon).
 *   2. An app.bsky.feed.post mirror — the human-readable version with the
 *      agent's stated reasoning, visible in the real Bluesky app.
 *
 * Note this is speech, not authority: the engine has already accepted the
 * move via FGA before anything is posted here.
 */
import { AtpAgent } from '@atproto/api'
import { ids } from '@atproto-agents/lexicon'
import type { Team } from '@atproto-agents/lexicon'
import type { ClueDecision, GuessDecision } from './brain.js'
import type { PublicState } from './engine.js'

export interface PosterOptions {
  service: string
  handle: string
  password: string
  team: Team
  log?: (message: string) => void
}

export interface AcceptedMove {
  kind: 'clue' | 'guess' | 'pass'
  decision: ClueDecision | GuessDecision
  state: PublicState
}

const TEAM_EMOJI: Record<Team, string> = { red: '🔴', blue: '🔵' }

/** Human-readable mirror text, ≤300 graphemes (Bluesky post limit). */
export function mirrorText(move: AcceptedMove, team: Team, handle: string): string {
  const name = handle.split('.')[0]
  const head =
    move.kind === 'clue'
      ? `${TEAM_EMOJI[team]} ${name} clues “${(move.decision as ClueDecision).word}” for ${(move.decision as ClueDecision).count}`
      : move.kind === 'guess'
        ? `${TEAM_EMOJI[team]} ${name} guesses “${(move.decision as GuessDecision).word}”`
        : `${TEAM_EMOJI[team]} ${name} passes`
  const tail = `\n\n🎲 ${move.state.id}`
  const budget = 300 - head.length - tail.length - 4 // "\n💭 "
  let reasoning = move.decision.reasoning.trim()
  if (reasoning.length > budget) reasoning = `${reasoning.slice(0, Math.max(0, budget - 1))}…`
  return reasoning ? `${head}\n💭 ${reasoning}${tail}` : `${head}${tail}`
}

export class MovePoster {
  private readonly agent: AtpAgent
  private did?: string

  constructor(private readonly opts: PosterOptions) {
    this.agent = new AtpAgent({ service: opts.service })
  }

  async login(): Promise<void> {
    const res = await this.agent.login({ identifier: this.opts.handle, password: this.opts.password })
    this.did = res.data.did
  }

  async postMove(move: AcceptedMove): Promise<void> {
    if (!this.did) throw new Error('poster not logged in')
    const createdAt = new Date().toISOString()
    const game = move.state.id
    const base = { game, team: this.opts.team, createdAt }

    const [collection, record] =
      move.kind === 'clue'
        ? [
            ids.clue,
            {
              $type: ids.clue,
              ...base,
              word: (move.decision as ClueDecision).word,
              count: (move.decision as ClueDecision).count,
              reasoning: move.decision.reasoning,
            },
          ]
        : move.kind === 'guess'
          ? [
              ids.guess,
              {
                $type: ids.guess,
                ...base,
                word: (move.decision as GuessDecision).word!,
                reasoning: move.decision.reasoning,
              },
            ]
          : [ids.pass, { $type: ids.pass, ...base }]

    // The structured record — validate:false until the lexicon is published
    // to the PDS; the schema lives in packages/lexicon.
    await this.agent.com.atproto.repo.createRecord({
      repo: this.did,
      collection,
      record,
      validate: false,
    })

    // The human-readable mirror, in the real Bluesky app.
    await this.agent.post({ text: mirrorText(move, this.opts.team, this.opts.handle), createdAt })
    this.opts.log?.(`posted ${move.kind} to ${this.opts.handle} (record + mirror)`)
  }
}
