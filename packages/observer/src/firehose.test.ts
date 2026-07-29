/**
 * The firehose column renders records written by anyone on the network, on a
 * projector, at a hacker conference. These are the rules that make that safe:
 * provenance for the referee, no free text from strangers, and hard bounds on
 * what one DID can occupy.
 */
import { describe, expect, it } from 'vitest'
import { REFEREE_DID, ROSTER } from './roster.js'
import { toRow } from './firehose.js'
import type { FirehoseRow } from './firehose.js'

const SEATED = Object.keys(ROSTER).find((d) => d !== REFEREE_DID)!
const STRANGER = 'did:plc:someoneuninvited00000000'
const NS = 'com.beckitrue.codenames.'
const GAME = 'bsideslv-live'

const clue = (over: Record<string, unknown> = {}) => ({
  game: GAME, team: 'red', word: 'ANCHOR', count: 3,
  reasoning: 'both are nautical', createdAt: '2026-07-19T18:00:00.000Z', ...over,
})

const row = (did: string, coll: string, rec: Record<string, unknown>, game: string | null = GAME) =>
  toRow(did, coll, rec, `at://${did}/${coll}/abc`, game)

describe('referee provenance', () => {
  const denial = {
    game: GAME, createdAt: '2026-07-19T18:00:00.000Z',
    lastEvent: { kind: 'key_peek', actor: 'did:plc:x', outcome: 'denied_authz', detail: 'lacks can_view_key' },
  }

  it('renders a denial from the referee', () => {
    const r = row(REFEREE_DID, `${NS}gameState`, denial)
    expect(r).toMatchObject({ kind: 'denial', seated: true })
    expect(r!.detail).toContain('lacks can_view_key')
  })

  it('DROPS a gameState record from anyone else — denials must be unforgeable', () => {
    expect(row(STRANGER, `${NS}gameState`, denial)).toBeNull()
    // Even a seated player cannot speak for the game.
    expect(row(SEATED, `${NS}gameState`, denial)).toBeNull()
  })

  it('drops accepted gameState — agents already report their own moves', () => {
    const accepted = { ...denial, lastEvent: { ...denial.lastEvent, outcome: 'accepted' } }
    expect(row(REFEREE_DID, `${NS}gameState`, accepted)).toBeNull()
  })
})

describe('strangers speak, but not in prose', () => {
  it('renders a stranger move WITHOUT their reasoning', () => {
    const r = row(STRANGER, `${NS}clue`, clue())
    expect(r).toMatchObject({ seated: false, word: 'ANCHOR', count: 3 })
    expect(r!.reasoning).toBeUndefined()
  })

  it('renders a seated agent WITH their reasoning', () => {
    const r = row(SEATED, `${NS}clue`, clue())
    expect(r).toMatchObject({ seated: true, reasoning: 'both are nautical' })
  })

  it('a stranger cannot smuggle prose through the word field either', () => {
    const r = row(STRANGER, `${NS}clue`, clue({ word: 'x'.repeat(500) }))
    expect(r!.word!.length).toBeLessThanOrEqual(40)
  })
})

describe('deliberation — argument, not action', () => {
  const delib = (over: Record<string, unknown> = {}) => ({
    game: GAME, team: 'red', stance: 'propose', word: 'DRAGON',
    reasoning: 'fits the theme', createdAt: '2026-07-19T18:00:00.000Z', ...over,
  })

  it('renders a seated agent deliberation WITH stance and reasoning', () => {
    const r = row(SEATED, `${NS}deliberate`, delib())
    expect(r).toMatchObject({ kind: 'deliberate', seated: true, stance: 'propose', word: 'DRAGON', reasoning: 'fits the theme' })
  })

  it('renders a stranger deliberation WITHOUT their reasoning', () => {
    const r = row(STRANGER, `${NS}deliberate`, delib({ stance: 'support' }))
    expect(r).toMatchObject({ kind: 'deliberate', seated: false, stance: 'support', word: 'DRAGON' })
    expect(r!.reasoning).toBeUndefined()
  })

  it('drops an unknown stance rather than rendering it', () => {
    expect(row(SEATED, `${NS}deliberate`, delib({ stance: 'sabotage' }))!.stance).toBeUndefined()
  })

  it('scopes deliberation to the current game like moves', () => {
    expect(row(SEATED, `${NS}deliberate`, delib({ game: 'some-other-game' }))).toBeNull()
  })
})

describe('sanitizing text that lands on a projector', () => {
  it('strips control characters, newlines and bidi overrides', () => {
    // U+202E flips rendering direction; U+200B is invisible. Both are
    // ways to make a projector show something other than the real text.
    const nasty = 'safe\u202Etxet neddih\nsecond line\u200B\u0007'
    const r = row(SEATED, `${NS}clue`, clue({ reasoning: nasty }))
    expect(r!.reasoning).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/)
    expect(r!.reasoning).not.toContain('\n')
    expect(r!.reasoning).toContain('safe')
  })

  it('truncates long reasoning', () => {
    const r = row(SEATED, `${NS}clue`, clue({ reasoning: 'y'.repeat(1000) }))
    expect(r!.reasoning!.length).toBeLessThanOrEqual(220)
    expect(r!.reasoning!.endsWith('…')).toBe(true)
  })

  it('drops reasoning that is only whitespace', () => {
    expect(row(SEATED, `${NS}clue`, clue({ reasoning: '   \n\t ' }))!.reasoning).toBeUndefined()
  })

  it('ignores non-string fields rather than rendering [object Object]', () => {
    const r = row(SEATED, `${NS}clue`, clue({ reasoning: { evil: true }, count: 'three' }))
    expect(r!.reasoning).toBeUndefined()
    expect(r!.count).toBeUndefined()
  })
})

describe('scoping', () => {
  it('drops records for a different game', () => {
    expect(row(SEATED, `${NS}clue`, clue({ game: 'some-other-game' }))).toBeNull()
  })

  it('shows every game when the engine is unreachable and no id is known', () => {
    expect(row(SEATED, `${NS}clue`, clue({ game: 'whatever' }), null)).not.toBeNull()
  })

  it('ignores collections outside our lexicon', () => {
    expect(row(SEATED, 'app.bsky.feed.post', { text: 'hi', createdAt: '2026-07-19T18:00:00.000Z' })).toBeNull()
  })
})
