/**
 * The referee's public voice. After every recorded event — accepted moves
 * AND denials — the engine publishes the canonical gameState record to the
 * referee's own PDS repo. The audit trail itself becomes signed, public,
 * append-only data: the closing argument of the demo.
 *
 * Bluesky mirrors are posted only for the moments an audience should see
 * in a feed: game start, game end, and every denial. (Accepted moves are
 * already mirrored by the agents themselves.)
 */
import { AtpAgent } from '@atproto/api'
import { ids } from '@atproto-agents/lexicon'
import type { GameStateRecord } from '@atproto-agents/lexicon'
import { publicBoard } from './game.js'
import type { StoredGame } from './store.js'

export interface RefereeOptions {
  service: string
  identifier: string
  password: string
  log?: (message: string) => void
}

/** Human label for an actor DID, derived from the game's role assignments. */
export function actorLabel(game: StoredGame, actor: string): string {
  const r = game.roles
  if (actor === r.spymasterRed) return 'Red Spymaster'
  if (actor === r.operativeRed) return 'Red Operative'
  if (actor === r.spymasterBlue) return 'Blue Spymaster'
  if (actor === r.operativeBlue) return 'Blue Operative'
  if (actor === 'referee') return 'Referee'
  // Not at this table — a foreign, federated agent (demo beat 5).
  return actor.startsWith('did:') ? `foreign agent …${actor.slice(-6)}` : actor
}

/** Canonical state snapshot carrying the event that produced it. */
export function buildGameStateRecord(game: StoredGame): GameStateRecord | null {
  const last = game.events.at(-1)
  if (!last) return null
  const s = game.state
  return {
    $type: ids.gameState,
    game: s.id,
    turn: s.turn,
    phase: s.phase,
    board: publicBoard(s),
    ...(s.currentClue ? { currentClue: s.currentClue } : {}),
    ...(s.winner ? { winner: s.winner } : {}),
    lastEvent: {
      kind: last.kind,
      actor: last.actor,
      outcome: last.outcome,
      ...(last.detail ? { detail: last.detail } : {}),
    },
    createdAt: new Date().toISOString(),
  }
}

const ATTEMPT: Record<string, string> = {
  clue: 'to give a clue',
  guess: 'to guess',
  pass: 'to pass',
  key_peek: 'to view the key card',
}

/** Feed-worthy moments only; everything else returns null (record-only). */
export function refereeMirrorText(game: StoredGame): string | null {
  const last = game.events.at(-1)
  if (!last) return null
  const id = game.state.id

  if (last.outcome !== 'accepted') {
    const head = `🚨 DENIED — ${actorLabel(game, last.actor)} attempted ${ATTEMPT[last.kind] ?? last.kind} and was refused`
    const why = last.outcome === 'denied_authz' ? 'not authorized (FGA)' : 'illegal under the rules'
    const tail = `\nSpeech is free; authority is scoped.\n\n🎲 ${id}`
    let detail = last.detail ?? ''
    const budget = 300 - head.length - why.length - tail.length - 6
    if (detail.length > budget) detail = `${detail.slice(0, Math.max(0, budget - 1))}…`
    return `${head}: ${why}${detail ? ` — ${detail}` : ''}.${tail}`
  }
  if (last.kind === 'game_start') {
    return `🎲 Game ${id} begins — ${game.state.turn.toUpperCase()} goes first. Every move, and every denied attempt, goes on the public record here.`
  }
  if (last.kind === 'game_end') {
    return `🏁 ${game.state.winner?.toUpperCase()} wins — ${game.state.winReason}.\n\n🎲 ${id}`
  }
  return null
}

export class RefereePoster {
  private readonly agent: AtpAgent
  private did?: string
  /** Serializes writes so records land in event order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: RefereeOptions) {
    this.agent = new AtpAgent({ service: opts.service })
  }

  async login(): Promise<void> {
    const res = await this.agent.login({ identifier: this.opts.identifier, password: this.opts.password })
    this.did = res.data.did
  }

  /** Fire-and-forget: snapshot synchronously, write in order, never throw. */
  publish(game: StoredGame): void {
    const record = buildGameStateRecord(game)
    if (!record || !this.did) return
    const text = refereeMirrorText(game)
    this.queue = this.queue
      .then(async () => {
        await this.agent.com.atproto.repo.createRecord({
          repo: this.did!,
          collection: ids.gameState,
          record,
          validate: false,
        })
        if (text) {
          await this.agent.post({ text, createdAt: record.createdAt })
          this.opts.log?.(`referee mirrored: ${text.split('\n')[0]}`)
        }
      })
      .catch((err) => this.opts.log?.(`referee publish failed: ${(err as Error).message}`))
  }
}
