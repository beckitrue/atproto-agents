/**
 * Codenames rules — a pure-function state machine.
 *
 * No I/O, no authz: authorization (who MAY act) is FGA's job and happens
 * before these functions are called. These functions decide whether a move
 * is LEGAL under the rules. The engine keeps the two failure modes distinct:
 * a rules violation is `denied_rules`, an FGA denial is `denied_authz`.
 */
import type { Card, CardType, ClueRef, Phase, Team } from '@atproto-agents/lexicon'

export interface GameState {
  id: string
  /** Full board including hidden card types — the key. Never sent to operatives. */
  board: KeyedCard[]
  startingTeam: Team
  turn: Team
  phase: Phase
  currentClue: ClueRef | null
  /** Guesses left this turn (count + 1 bonus guess, per classic rules) */
  guessesRemaining: number
  winner: Team | null
  winReason: string | null
}

export interface KeyedCard {
  word: string
  cardType: CardType
  revealed: boolean
}

export type RuleErrorCode =
  | 'wrong_phase'
  | 'wrong_turn'
  | 'clue_word_on_board'
  | 'invalid_count'
  | 'word_not_on_board'
  | 'already_revealed'
  | 'game_finished'

export class GameRuleError extends Error {
  constructor(
    public readonly code: RuleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GameRuleError'
  }
}

/** Deterministic PRNG (mulberry32) so scripted-fallback demos replay exactly */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * Create a game: 25 words — 9 for the starting team, 8 for the other,
 * 7 bystanders, 1 assassin.
 */
export function createGame(
  id: string,
  words: readonly string[],
  opts: { startingTeam?: Team; rng?: () => number } = {},
): GameState {
  const rng = opts.rng ?? Math.random
  const startingTeam = opts.startingTeam ?? (rng() < 0.5 ? 'red' : 'blue')
  const otherTeam: Team = startingTeam === 'red' ? 'blue' : 'red'

  if (words.length < 25) {
    throw new Error(`need at least 25 words, got ${words.length}`)
  }
  const boardWords = shuffle(words, rng).slice(0, 25)
  const types: CardType[] = [
    ...Array<CardType>(9).fill(startingTeam),
    ...Array<CardType>(8).fill(otherTeam),
    ...Array<CardType>(7).fill('bystander'),
    'assassin',
  ]
  const shuffledTypes = shuffle(types, rng)

  return {
    id,
    board: boardWords.map((word, i) => ({
      word,
      cardType: shuffledTypes[i]!,
      revealed: false,
    })),
    startingTeam,
    turn: startingTeam,
    phase: 'awaiting_clue',
    currentClue: null,
    guessesRemaining: 0,
    winner: null,
    winReason: null,
  }
}

function assertActive(state: GameState): void {
  if (state.phase === 'finished') {
    throw new GameRuleError('game_finished', 'the game is over')
  }
}

function endTurn(state: GameState): GameState {
  return {
    ...state,
    turn: state.turn === 'red' ? 'blue' : 'red',
    phase: 'awaiting_clue',
    currentClue: null,
    guessesRemaining: 0,
  }
}

function teamCardsRemaining(board: KeyedCard[], team: Team): number {
  return board.filter((c) => c.cardType === team && !c.revealed).length
}

function finish(state: GameState, winner: Team, reason: string): GameState {
  return { ...state, phase: 'finished', winner, winReason: reason }
}

/** Spymaster gives a clue. Legal only in awaiting_clue phase, on their turn. */
export function giveClue(
  state: GameState,
  team: Team,
  word: string,
  count: number,
): GameState {
  assertActive(state)
  if (state.phase !== 'awaiting_clue') {
    throw new GameRuleError('wrong_phase', 'a clue has already been given this turn')
  }
  if (team !== state.turn) {
    throw new GameRuleError('wrong_turn', `it is ${state.turn}'s turn`)
  }
  if (!Number.isInteger(count) || count < 1 || count > 9) {
    throw new GameRuleError('invalid_count', 'count must be an integer from 1 to 9')
  }
  const clueUpper = word.trim().toUpperCase()
  const onBoard = state.board.some((c) => !c.revealed && c.word === clueUpper)
  if (onBoard) {
    throw new GameRuleError('clue_word_on_board', 'clue must not be a visible board word')
  }
  return {
    ...state,
    phase: 'awaiting_guesses',
    currentClue: { word: clueUpper, count, team },
    guessesRemaining: count + 1,
  }
}

/** Operative guesses a card. Legal only in awaiting_guesses phase, on their turn. */
export function guess(state: GameState, team: Team, word: string): GameState {
  assertActive(state)
  if (state.phase !== 'awaiting_guesses') {
    throw new GameRuleError('wrong_phase', 'no active clue to guess against')
  }
  if (team !== state.turn) {
    throw new GameRuleError('wrong_turn', `it is ${state.turn}'s turn`)
  }
  const wordUpper = word.trim().toUpperCase()
  const idx = state.board.findIndex((c) => c.word === wordUpper)
  if (idx === -1) {
    throw new GameRuleError('word_not_on_board', `"${wordUpper}" is not on the board`)
  }
  const card = state.board[idx]!
  if (card.revealed) {
    throw new GameRuleError('already_revealed', `"${wordUpper}" is already revealed`)
  }

  const board = state.board.map((c, i) => (i === idx ? { ...c, revealed: true } : c))
  const next: GameState = { ...state, board }
  const otherTeam: Team = team === 'red' ? 'blue' : 'red'

  if (card.cardType === 'assassin') {
    return finish(next, otherTeam, `${team} revealed the assassin`)
  }
  if (card.cardType === team) {
    if (teamCardsRemaining(board, team) === 0) {
      return finish(next, team, `${team} found all their agents`)
    }
    const guessesRemaining = state.guessesRemaining - 1
    if (guessesRemaining <= 0) {
      return endTurn(next)
    }
    return { ...next, guessesRemaining }
  }
  if (card.cardType === otherTeam) {
    if (teamCardsRemaining(board, otherTeam) === 0) {
      return finish(next, otherTeam, `${team} revealed ${otherTeam}'s last agent for them`)
    }
    return endTurn(next)
  }
  // bystander
  return endTurn(next)
}

/** Operative team ends its guessing voluntarily. */
export function pass(state: GameState, team: Team): GameState {
  assertActive(state)
  if (state.phase !== 'awaiting_guesses') {
    throw new GameRuleError('wrong_phase', 'can only pass during the guessing phase')
  }
  if (team !== state.turn) {
    throw new GameRuleError('wrong_turn', `it is ${state.turn}'s turn`)
  }
  return endTurn(state)
}

/** Public view of the board: card types only where revealed. The key stays secret. */
export function publicBoard(state: GameState): Card[] {
  return state.board.map((c) => ({
    word: c.word,
    revealed: c.revealed,
    ...(c.revealed ? { cardType: c.cardType } : {}),
  }))
}
