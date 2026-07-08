/**
 * In-memory game store. One demo, a handful of games — a Map is plenty.
 * The durable, public record is the gameState records the referee posts
 * to AT Proto, not this store.
 */
import type { GameEvent } from '@atproto-agents/lexicon'
import type { GameState } from './game.js'
import type { RoleAssignments } from './fga.js'

export interface StoredGame {
  state: GameState
  roles: RoleAssignments
  /** Every attempt — accepted or denied — in order. The audit log. */
  events: Array<GameEvent & { at: string }>
}

export class GameStore {
  private games = new Map<string, StoredGame>()

  create(state: GameState, roles: RoleAssignments): StoredGame {
    const game: StoredGame = { state, roles, events: [] }
    this.games.set(state.id, game)
    return game
  }

  get(id: string): StoredGame | undefined {
    return this.games.get(id)
  }

  list(): StoredGame[] {
    return [...this.games.values()]
  }
}
