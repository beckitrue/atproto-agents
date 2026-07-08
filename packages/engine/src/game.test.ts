import { describe, expect, it } from 'vitest'
import { GameRuleError, createGame, giveClue, guess, pass, publicBoard, seededRng } from './game.js'
import { WORDS } from './wordlist.js'
import type { GameState } from './game.js'

const newGame = (seed = 42): GameState =>
  createGame('test', WORDS, { startingTeam: 'red', rng: seededRng(seed) })

/** Find an unrevealed board word of the given card type */
const wordOfType = (state: GameState, type: string): string =>
  state.board.find((c) => c.cardType === type && !c.revealed)!.word

describe('createGame', () => {
  it('deals 25 cards: 9 starting team, 8 other, 7 bystanders, 1 assassin', () => {
    const g = newGame()
    expect(g.board).toHaveLength(25)
    expect(g.board.filter((c) => c.cardType === 'red')).toHaveLength(9)
    expect(g.board.filter((c) => c.cardType === 'blue')).toHaveLength(8)
    expect(g.board.filter((c) => c.cardType === 'bystander')).toHaveLength(7)
    expect(g.board.filter((c) => c.cardType === 'assassin')).toHaveLength(1)
    expect(g.turn).toBe('red')
    expect(g.phase).toBe('awaiting_clue')
  })

  it('is deterministic for a given seed (scripted fallback depends on this)', () => {
    const a = newGame(7)
    const b = newGame(7)
    expect(a.board).toEqual(b.board)
  })
})

describe('giveClue', () => {
  it('accepts a legal clue and opens guessing with count+1 guesses', () => {
    const g = giveClue(newGame(), 'red', 'ocean-adjacent', 2)
    expect(g.phase).toBe('awaiting_guesses')
    expect(g.currentClue).toEqual({ word: 'OCEAN-ADJACENT', count: 2, team: 'red' })
    expect(g.guessesRemaining).toBe(3)
  })

  it('rejects a clue from the off-turn team (demo beat 2)', () => {
    expect(() => giveClue(newGame(), 'blue', 'sneaky', 2)).toThrowError(
      expect.objectContaining({ code: 'wrong_turn' }),
    )
  })

  it('rejects a clue word that is on the board', () => {
    const g = newGame()
    const boardWord = g.board[0]!.word
    expect(() => giveClue(g, 'red', boardWord, 1)).toThrowError(
      expect.objectContaining({ code: 'clue_word_on_board' }),
    )
  })

  it('rejects a second clue in the same turn', () => {
    const g = giveClue(newGame(), 'red', 'valid', 1)
    expect(() => giveClue(g, 'red', 'again', 1)).toThrowError(
      expect.objectContaining({ code: 'wrong_phase' }),
    )
  })

  it('rejects out-of-range counts', () => {
    expect(() => giveClue(newGame(), 'red', 'valid', 0)).toThrow(GameRuleError)
    expect(() => giveClue(newGame(), 'red', 'valid', 10)).toThrow(GameRuleError)
  })
})

describe('guess', () => {
  const inGuessing = (seed = 42) => giveClue(newGame(seed), 'red', 'valid', 2)

  it('correct guess reveals the card and keeps the turn', () => {
    const g0 = inGuessing()
    const word = wordOfType(g0, 'red')
    const g1 = guess(g0, 'red', word)
    expect(g1.board.find((c) => c.word === word)!.revealed).toBe(true)
    expect(g1.turn).toBe('red')
    expect(g1.guessesRemaining).toBe(2)
  })

  it('guessing before any clue is a wrong_phase violation', () => {
    expect(() => guess(newGame(), 'red', 'ANYTHING')).toThrowError(
      expect.objectContaining({ code: 'wrong_phase' }),
    )
  })

  it("guessing on the other team's turn is a wrong_turn violation", () => {
    expect(() => guess(inGuessing(), 'blue', 'ANYTHING')).toThrowError(
      expect.objectContaining({ code: 'wrong_turn' }),
    )
  })

  it('opponent card ends the turn', () => {
    const g0 = inGuessing()
    const g1 = guess(g0, 'red', wordOfType(g0, 'blue'))
    expect(g1.turn).toBe('blue')
    expect(g1.phase).toBe('awaiting_clue')
    expect(g1.currentClue).toBeNull()
  })

  it('bystander ends the turn', () => {
    const g0 = inGuessing()
    const g1 = guess(g0, 'red', wordOfType(g0, 'bystander'))
    expect(g1.turn).toBe('blue')
  })

  it('assassin loses the game immediately', () => {
    const g0 = inGuessing()
    const g1 = guess(g0, 'red', wordOfType(g0, 'assassin'))
    expect(g1.phase).toBe('finished')
    expect(g1.winner).toBe('blue')
    expect(g1.winReason).toMatch(/assassin/)
  })

  it('exhausting guesses ends the turn', () => {
    let g = giveClue(newGame(), 'red', 'valid', 1) // 2 guesses
    g = guess(g, 'red', wordOfType(g, 'red'))
    expect(g.turn).toBe('red')
    g = guess(g, 'red', wordOfType(g, 'red'))
    expect(g.turn).toBe('blue')
  })

  it('revealing all team cards wins the game', () => {
    let g = giveClue(newGame(), 'red', 'valid', 9) // 10 guesses, 9 red cards
    for (let i = 0; i < 9; i++) {
      g = guess(g, 'red', wordOfType(g, 'red'))
    }
    expect(g.phase).toBe('finished')
    expect(g.winner).toBe('red')
  })

  it('rejects an already-revealed word', () => {
    let g = giveClue(newGame(), 'red', 'valid', 3)
    const word = wordOfType(g, 'red')
    g = guess(g, 'red', word)
    expect(() => guess(g, 'red', word)).toThrowError(
      expect.objectContaining({ code: 'already_revealed' }),
    )
  })

  it('rejects moves after the game is finished', () => {
    const g0 = inGuessing()
    const g1 = guess(g0, 'red', wordOfType(g0, 'assassin'))
    expect(() => guess(g1, 'blue', wordOfType(g1, 'blue'))).toThrowError(
      expect.objectContaining({ code: 'game_finished' }),
    )
  })
})

describe('pass', () => {
  it('ends the guessing turn', () => {
    const g0 = giveClue(newGame(), 'red', 'valid', 2)
    const g1 = pass(g0, 'red')
    expect(g1.turn).toBe('blue')
    expect(g1.phase).toBe('awaiting_clue')
  })

  it('cannot pass during clue phase', () => {
    expect(() => pass(newGame(), 'red')).toThrowError(
      expect.objectContaining({ code: 'wrong_phase' }),
    )
  })
})

describe('publicBoard', () => {
  it('hides card types until revealed — the key stays secret', () => {
    const g0 = giveClue(newGame(), 'red', 'valid', 2)
    const word = wordOfType(g0, 'red')
    const g1 = guess(g0, 'red', word)
    const pub = publicBoard(g1)
    const revealed = pub.find((c) => c.word === word)!
    expect(revealed.cardType).toBe('red')
    for (const card of pub.filter((c) => !c.revealed)) {
      expect(card.cardType).toBeUndefined()
    }
  })
})
