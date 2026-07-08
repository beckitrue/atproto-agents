import { describe, expect, it } from 'vitest'
import { mirrorText } from './poster.js'
import type { AcceptedMove } from './poster.js'
import type { PublicState } from './engine.js'

const state = { id: 'demo-1' } as PublicState

const move = (over: Partial<AcceptedMove>): AcceptedMove => ({
  kind: 'clue',
  decision: { word: 'FIELDS', count: 3, reasoning: 'open plots of growing land' },
  state,
  ...over,
})

describe('mirrorText', () => {
  it('formats a clue with team, reasoning, and game id', () => {
    const text = mirrorText(move({}), 'red', 'red-spymaster.beckitrue.com')
    expect(text).toContain('🔴 red-spymaster clues “FIELDS” for 3')
    expect(text).toContain('💭 open plots of growing land')
    expect(text).toContain('🎲 demo-1')
  })

  it('formats guess and pass', () => {
    const guess = mirrorText(
      move({ kind: 'guess', decision: { action: 'guess', word: 'MEADOW', reasoning: 'a meadow is a field' } }),
      'blue',
      'blue-operative.beckitrue.com',
    )
    expect(guess).toContain('🔵 blue-operative guesses “MEADOW”')
    const pass = mirrorText(
      move({ kind: 'pass', decision: { action: 'pass', reasoning: 'nothing fits' } }),
      'blue',
      'blue-operative.beckitrue.com',
    )
    expect(pass).toContain('blue-operative passes')
  })

  it('stays within the 300-char Bluesky limit for long reasoning', () => {
    const text = mirrorText(
      move({ decision: { word: 'FIELDS', count: 3, reasoning: 'x'.repeat(500) } }),
      'red',
      'red-spymaster.beckitrue.com',
    )
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text).toContain('…')
    expect(text).toContain('🎲 demo-1') // the game tag survives truncation
  })
})
