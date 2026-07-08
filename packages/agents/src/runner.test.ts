import { describe, expect, it } from 'vitest'
import { runAgent } from './runner.js'
import type { Brain, KeyCard } from './brain.js'
import { ScriptedBrain } from './brain.js'
import type { EngineApi, MoveResult, PublicState } from './engine.js'

const KEY: KeyCard[] = [
  { word: 'ANCHOR', cardType: 'red', revealed: false },
  { word: 'BADGE', cardType: 'blue', revealed: false },
]

const state = (over: Partial<PublicState>): PublicState => ({
  id: 'g1',
  turn: 'red',
  phase: 'awaiting_clue',
  board: KEY.map(({ word, revealed }) => ({ word, revealed })),
  currentClue: null,
  winner: null,
  winReason: null,
  ...over,
})

const finished = state({ phase: 'finished', winner: 'red', winReason: 'test over' })
const accepted = (s: PublicState): MoveResult => ({ outcome: 'accepted', state: s })

/** Engine fake: serves states in order; records the moves it receives. */
function fakeEngine(states: PublicState[], moveResults: MoveResult[]): EngineApi & { moves: string[] } {
  let stateIdx = 0
  let moveIdx = 0
  return {
    moves: [],
    async state() {
      return states[Math.min(stateIdx++, states.length - 1)]!
    },
    async key() {
      return KEY
    },
    async clue(_g, word, count) {
      this.moves.push(`clue:${word}:${count}`)
      return moveResults[moveIdx++]!
    },
    async guess(_g, word) {
      this.moves.push(`guess:${word}`)
      return moveResults[moveIdx++]!
    },
    async pass() {
      this.moves.push('pass')
      return moveResults[moveIdx++]!
    },
  }
}

describe('runAgent', () => {
  it('spymaster clues on its turn, then returns when the game finishes', async () => {
    const engine = fakeEngine([state({}), finished], [accepted(state({ phase: 'awaiting_guesses' }))])
    const moves: string[] = []
    const final = await runAgent({
      engine,
      brain: new ScriptedBrain(1),
      agent: { name: 'red-spymaster', team: 'red', role: 'spymaster' },
      gameId: 'g1',
      pollMs: 1,
      log: () => {},
      onMove: ({ kind }) => {
        moves.push(kind)
      },
    })
    expect(engine.moves).toHaveLength(1)
    expect(engine.moves[0]).toMatch(/^clue:/)
    expect(moves).toEqual(['clue'])
    expect(final.winner).toBe('red')
  })

  it('does nothing off-turn or in the wrong phase', async () => {
    const engine = fakeEngine(
      [state({ turn: 'blue' }), state({ phase: 'awaiting_guesses' }), finished],
      [],
    )
    await runAgent({
      engine,
      brain: new ScriptedBrain(1),
      agent: { name: 'red-spymaster', team: 'red', role: 'spymaster' },
      gameId: 'g1',
      pollMs: 1,
      log: () => {},
    })
    expect(engine.moves).toHaveLength(0)
  })

  it('retries a rules-denied move once with the fallback brain', async () => {
    const illegal: Brain = {
      kind: 'illegal',
      giveClue: async () => ({ word: 'ANCHOR', count: 1, reasoning: 'board word — illegal' }),
      guess: async () => ({ action: 'guess', word: 'ANCHOR', reasoning: '' }),
    }
    const engine = fakeEngine(
      [state({}), finished],
      [
        { outcome: 'denied_rules', status: 422, detail: 'clue must not be a visible board word' },
        accepted(state({ phase: 'awaiting_guesses' })),
      ],
    )
    await runAgent({
      engine,
      brain: illegal,
      rulesFallback: new ScriptedBrain(1),
      agent: { name: 'red-spymaster', team: 'red', role: 'spymaster' },
      gameId: 'g1',
      pollMs: 1,
      log: () => {},
    })
    expect(engine.moves).toHaveLength(2)
    expect(engine.moves[0]).toBe('clue:ANCHOR:1')
    expect(engine.moves[1]).not.toBe(engine.moves[0])
  })

  it('gives up after 5 consecutive authz denials', async () => {
    const denied: MoveResult = { outcome: 'denied_authz', status: 403, detail: 'no tuple' }
    const engine = fakeEngine([state({})], [denied, denied, denied, denied, denied])
    await expect(
      runAgent({
        engine,
        brain: new ScriptedBrain(1),
        agent: { name: 'red-spymaster', team: 'red', role: 'spymaster' },
        gameId: 'g1',
        pollMs: 1,
        log: () => {},
      }),
    ).rejects.toThrow(/consecutive denials/)
    expect(engine.moves).toHaveLength(5)
  })

  it('operative guesses against the clue and tracks guesses per clue', async () => {
    const guessing = state({
      phase: 'awaiting_guesses',
      currentClue: { word: 'NEBULA', count: 1, team: 'red' },
    })
    const engine = fakeEngine(
      [guessing, guessing, finished],
      [accepted(guessing), accepted(state({ turn: 'blue' }))],
    )
    await runAgent({
      engine,
      brain: new ScriptedBrain(1),
      agent: { name: 'red-operative', team: 'red', role: 'operative' },
      gameId: 'g1',
      pollMs: 1,
      log: () => {},
    })
    // scripted brain: one guess, then pass on the same clue
    expect(engine.moves[0]).toMatch(/^guess:/)
    expect(engine.moves[1]).toBe('pass')
  })
})
