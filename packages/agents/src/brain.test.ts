import { describe, expect, it } from 'vitest'
import { ScriptedBrain, withFallback } from './brain.js'
import type { Brain, KeyCard, SpymasterView } from './brain.js'
import { LlmBrain } from './llm.js'
import type Anthropic from '@anthropic-ai/sdk'

const KEY: KeyCard[] = [
  { word: 'ANCHOR', cardType: 'red', revealed: false },
  { word: 'APPLE', cardType: 'red', revealed: false },
  { word: 'ARROW', cardType: 'red', revealed: true },
  { word: 'BADGE', cardType: 'blue', revealed: false },
  { word: 'BANK', cardType: 'bystander', revealed: false },
  { word: 'BARREL', cardType: 'assassin', revealed: false },
]

const spymasterView: SpymasterView = { team: 'red', key: KEY }
const operativeView = {
  team: 'red' as const,
  board: KEY.map(({ word, revealed, cardType }) => (revealed ? { word, revealed, cardType } : { word, revealed })),
  clue: { word: 'NEBULA', count: 2, team: 'red' as const },
  guessesMade: 0,
}

describe('ScriptedBrain', () => {
  it('clues a legal off-board word for min(2, remaining)', async () => {
    const clue = await new ScriptedBrain(1).giveClue(spymasterView)
    expect(KEY.map((c) => c.word)).not.toContain(clue.word)
    expect(clue.count).toBe(2) // two unrevealed red cards
  })

  it('guesses one unrevealed card, then passes on the same clue', async () => {
    const brain = new ScriptedBrain(42)
    const first = await brain.guess(operativeView)
    expect(first.action).toBe('guess')
    expect(operativeView.board.filter((c) => !c.revealed).map((c) => c.word)).toContain(first.word)
    const second = await brain.guess({ ...operativeView, guessesMade: 1 })
    expect(second.action).toBe('pass')
  })

  it('is deterministic for a given seed (replayable demo)', async () => {
    const a = await new ScriptedBrain(7).guess(operativeView)
    const b = await new ScriptedBrain(7).guess(operativeView)
    expect(a).toEqual(b)
  })
})

describe('withFallback', () => {
  const failing: Brain = {
    kind: 'failing',
    giveClue: async () => {
      throw new Error('api down')
    },
    guess: async () => {
      throw new Error('api down')
    },
  }

  it('uses the fallback when the primary throws, and reports it', async () => {
    const errors: string[] = []
    const brain = withFallback(failing, new ScriptedBrain(1), (e) => errors.push(e.message))
    const clue = await brain.giveClue(spymasterView)
    expect(clue.word).toBeTruthy()
    expect(errors).toEqual(['api down'])
  })

  it('passes primary results through untouched', async () => {
    const brain = withFallback(new ScriptedBrain(1), failing)
    await expect(brain.giveClue(spymasterView)).resolves.toMatchObject({ count: 2 })
  })
})

describe('LlmBrain output validation', () => {
  const fakeClient = (json: unknown) =>
    ({
      messages: {
        create: async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(json) }],
        }),
      },
    }) as unknown as Anthropic

  it('normalizes a valid clue to uppercase', async () => {
    const brain = new LlmBrain({ client: fakeClient({ word: 'harbor', count: 2, reasoning: 'boats' }) })
    await expect(brain.giveClue(spymasterView)).resolves.toMatchObject({ word: 'HARBOR', count: 2 })
  })

  it('rejects a clue that is an unrevealed board word (fallback trigger)', async () => {
    const brain = new LlmBrain({ client: fakeClient({ word: 'anchor', count: 2, reasoning: 'oops' }) })
    await expect(brain.giveClue(spymasterView)).rejects.toThrow(/board word/)
  })

  it('rejects a guess that is not an unrevealed board word', async () => {
    const brain = new LlmBrain({
      client: fakeClient({ action: 'guess', word: 'ZEPPELIN', reasoning: 'hm' }),
    })
    await expect(brain.guess(operativeView)).rejects.toThrow(/not on the unrevealed board/)
  })

  it('surfaces refusals as errors (fallback trigger)', async () => {
    const client = {
      messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) },
    } as unknown as Anthropic
    const brain = new LlmBrain({ client })
    await expect(brain.giveClue(spymasterView)).rejects.toThrow(/refused/)
  })
})
