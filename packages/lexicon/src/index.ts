/**
 * TypeScript types for the com.beckitrue.codenames lexicons.
 *
 * Hand-written to match the JSON schemas in ../lexicons/ for now;
 * can be replaced with @atproto/lex-cli codegen once the schemas settle.
 */

export type Team = 'red' | 'blue'
export type CardType = 'red' | 'blue' | 'bystander' | 'assassin'
export type Phase = 'awaiting_clue' | 'awaiting_guesses' | 'finished'

/** NSIDs for the game record collections */
export const ids = {
  clue: 'com.beckitrue.codenames.clue',
  guess: 'com.beckitrue.codenames.guess',
  pass: 'com.beckitrue.codenames.pass',
  gameState: 'com.beckitrue.codenames.gameState',
} as const

/** com.beckitrue.codenames.clue */
export interface ClueRecord {
  $type?: typeof ids.clue
  game: string
  team: Team
  word: string
  count: number
  /** The agent's stated reasoning, for human observers */
  reasoning?: string
  createdAt: string
}

/** com.beckitrue.codenames.guess */
export interface GuessRecord {
  $type?: typeof ids.guess
  game: string
  team: Team
  word: string
  reasoning?: string
  createdAt: string
}

/** com.beckitrue.codenames.pass */
export interface PassRecord {
  $type?: typeof ids.pass
  game: string
  team: Team
  createdAt: string
}

/** com.beckitrue.codenames.gameState#card */
export interface Card {
  word: string
  revealed: boolean
  /** Only present when revealed — the key stays secret */
  cardType?: CardType
}

/** com.beckitrue.codenames.gameState#clueRef */
export interface ClueRef {
  word: string
  count: number
  team: Team
}

export type EventKind = 'clue' | 'guess' | 'pass' | 'game_start' | 'game_end'

/**
 * denied_authz = FGA said no; denied_rules = authorized but illegal move.
 * Keeping these distinct is the point of the demo.
 */
export type EventOutcome = 'accepted' | 'denied_authz' | 'denied_rules'

/** com.beckitrue.codenames.gameState#event */
export interface GameEvent {
  kind: EventKind
  /** DID of the acting agent */
  actor: string
  outcome: EventOutcome
  detail?: string
}

/** com.beckitrue.codenames.gameState */
export interface GameStateRecord {
  $type?: typeof ids.gameState
  game: string
  turn: Team
  phase: Phase
  board: Card[]
  currentClue?: ClueRef
  winner?: Team
  lastEvent: GameEvent
  createdAt: string
}
