import { describe, expect, it } from 'vitest'
import { actorLabel, buildGameStateRecord, refereeMirrorText } from './referee.js'
import { createGame, seededRng } from './game.js'
import { WORDS } from './wordlist.js'
import type { StoredGame } from './store.js'
import type { GameEvent } from '@atproto-agents/lexicon'

const ROLES = {
  spymasterRed: 'did:plc:redspy',
  operativeRed: 'did:plc:redop',
  spymasterBlue: 'did:plc:bluespy',
  operativeBlue: 'did:plc:blueop',
}

const game = (events: Array<GameEvent & { at: string }>): StoredGame => ({
  state: createGame('g1', WORDS, { startingTeam: 'red', rng: seededRng(1) }),
  roles: ROLES,
  events,
})

const at = new Date().toISOString()

describe('buildGameStateRecord', () => {
  it('snapshots public state with the last event; the key stays hidden', () => {
    const g = game([{ kind: 'game_start', actor: 'referee', outcome: 'accepted', at }])
    const record = buildGameStateRecord(g)!
    expect(record.$type).toBe('com.beckitrue.codenames.gameState')
    expect(record.game).toBe('g1')
    expect(record.lastEvent).toMatchObject({ kind: 'game_start', outcome: 'accepted' })
    expect(record.board).toHaveLength(25)
    expect(record.board.every((c) => c.cardType === undefined)).toBe(true) // nothing revealed yet
  })

  it('returns null with no events', () => {
    expect(buildGameStateRecord(game([]))).toBeNull()
  })
})

describe('refereeMirrorText', () => {
  it('mirrors game start and game end', () => {
    expect(refereeMirrorText(game([{ kind: 'game_start', actor: 'referee', outcome: 'accepted', at }]))).toContain(
      'RED goes first',
    )
    const ended = game([{ kind: 'game_end', actor: 'referee', outcome: 'accepted', at }])
    ended.state = { ...ended.state, winner: 'blue', winReason: 'red revealed the assassin' }
    expect(refereeMirrorText(ended)).toContain('🏁 BLUE wins — red revealed the assassin')
  })

  it('mirrors denials with a readable actor label and stays under 300 chars', () => {
    const text = refereeMirrorText(
      game([
        {
          kind: 'guess',
          actor: ROLES.spymasterRed,
          outcome: 'denied_authz',
          detail: 'x'.repeat(400),
          at,
        },
      ]),
    )!
    expect(text).toContain('🚨 DENIED — Red Spymaster attempted to guess')
    expect(text).toContain('not authorized (FGA)')
    expect(text.length).toBeLessThanOrEqual(300)
  })

  it('labels a non-roster DID as a foreign agent (beat 5)', () => {
    const text = refereeMirrorText(
      game([{ kind: 'guess', actor: 'did:plc:someforeigner', outcome: 'denied_authz', at }]),
    )!
    expect(text).toContain('foreign agent …eigner')
  })

  it('stays silent on accepted moves — the agents speak for themselves', () => {
    expect(
      refereeMirrorText(game([{ kind: 'clue', actor: ROLES.spymasterRed, outcome: 'accepted', at }])),
    ).toBeNull()
  })
})

describe('actorLabel', () => {
  it('maps roster DIDs to roles', () => {
    const g = game([])
    expect(actorLabel(g, ROLES.operativeBlue)).toBe('Blue Operative')
    expect(actorLabel(g, 'referee')).toBe('Referee')
  })
})
