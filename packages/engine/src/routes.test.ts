/**
 * Route pipeline tests — authenticate → authorize → validate → commit,
 * exercised over real HTTP handling (fastify inject) with an in-memory
 * FGA fake that evaluates the same rewrite rules as infra/fga/model.fga.
 *
 * These are the five demo beats, as executable checks.
 */
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { registerRoutes } from './routes.js'
import { GameStore } from './store.js'
import { AuthError } from './auth.js'
import type { AgentIdentity } from './auth.js'
import type { AuthorizerApi, Permission, RoleAssignments } from './fga.js'
import { createGame, seededRng } from './game.js'
import { WORDS } from './wordlist.js'

const DIDS = {
  redSpymaster: 'did:plc:redspymaster',
  redOperative: 'did:plc:redoperative',
  blueSpymaster: 'did:plc:bluespymaster',
  blueOperative: 'did:plc:blueoperative',
  /** Beat 5: valid identity from a foreign PDS — authenticated, zero tuples */
  guest: 'did:plc:foreignguest',
}

const ROLES: RoleAssignments = {
  spymasterRed: DIDS.redSpymaster,
  operativeRed: DIDS.redOperative,
  spymasterBlue: DIDS.blueSpymaster,
  operativeBlue: DIDS.blueOperative,
}

/** Bearer tokens are just the agent names; the fake verifier maps them to DIDs. */
const TOKENS: Record<string, string> = {
  'red-spymaster': DIDS.redSpymaster,
  'red-operative': DIDS.redOperative,
  'blue-spymaster': DIDS.blueSpymaster,
  'blue-operative': DIDS.blueOperative,
  guest: DIDS.guest,
}

async function fakeVerifyBearer(header: string | undefined): Promise<AgentIdentity> {
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  const did = token ? TOKENS[token] : undefined
  if (!did) throw new AuthError('missing or unknown token')
  return { sub: `client-${token}`, did }
}

/** In-memory FGA: a tuple set plus the model's rewrite rules. */
class FakeFga implements AuthorizerApi {
  tuples = new Set<string>()

  private key(did: string, relation: string, gameId: string): string {
    return `${did}|${relation}|game:${gameId}`
  }
  has(did: string, relation: string, gameId: string): boolean {
    return this.tuples.has(this.key(did, relation, gameId))
  }

  async check(did: string, permission: Permission, gameId: string): Promise<boolean> {
    switch (permission) {
      case 'can_give_clue':
        return this.has(did, 'active_clue_giver', gameId)
      case 'can_guess':
        return this.has(did, 'active_guesser', gameId)
      case 'can_view_key':
        return this.has(did, 'spymaster_red', gameId) || this.has(did, 'spymaster_blue', gameId)
    }
  }

  async assignRoles(gameId: string, roles: RoleAssignments): Promise<void> {
    this.tuples.add(this.key(roles.spymasterRed, 'spymaster_red', gameId))
    this.tuples.add(this.key(roles.operativeRed, 'operative_red', gameId))
    this.tuples.add(this.key(roles.spymasterBlue, 'spymaster_blue', gameId))
    this.tuples.add(this.key(roles.operativeBlue, 'operative_blue', gameId))
  }

  async transitionTurn(
    gameId: string,
    opts: {
      revoke?: { clueGiver?: string; guesser?: string }
      grant: { clueGiver?: string; guesser?: string }
    },
  ): Promise<void> {
    if (opts.revoke?.clueGiver) this.tuples.delete(this.key(opts.revoke.clueGiver, 'active_clue_giver', gameId))
    if (opts.revoke?.guesser) this.tuples.delete(this.key(opts.revoke.guesser, 'active_guesser', gameId))
    if (opts.grant.clueGiver) this.tuples.add(this.key(opts.grant.clueGiver, 'active_clue_giver', gameId))
    if (opts.grant.guesser) this.tuples.add(this.key(opts.grant.guesser, 'active_guesser', gameId))
  }
}

// A seed whose game starts with red, so the beats read like the script.
const SEED = (() => {
  for (let s = 0; s < 100; s++) {
    if (createGame('x', WORDS, { rng: seededRng(s) }).startingTeam === 'red') return s
  }
  throw new Error('unreachable')
})()

/** The board the engine will deal for SEED — lets tests pick words by card type. */
const reference = createGame('g1', WORDS, { rng: seededRng(SEED) })
const wordOfType = (type: string, skip = 0): string =>
  reference.board.filter((c) => c.cardType === type)[skip]!.word

let app: FastifyInstance
let fga: FakeFga
let store: GameStore

const post = (url: string, token: string | null, body?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body !== undefined ? { payload: body as object } : {}),
  })

const get = (url: string, token?: string) =>
  app.inject({
    method: 'GET',
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  })

beforeEach(async () => {
  app = Fastify()
  fga = new FakeFga()
  store = new GameStore()
  registerRoutes(app, { store, authorizer: fga, verifyBearer: fakeVerifyBearer })
  const res = await post('/games', null, { id: 'g1', roles: ROLES, seed: SEED })
  expect(res.statusCode).toBe(200)
})

describe('game creation', () => {
  it('writes standing role tuples and grants the starting pair their turn tuples', () => {
    expect(fga.has(DIDS.redSpymaster, 'spymaster_red', 'g1')).toBe(true)
    expect(fga.has(DIDS.blueOperative, 'operative_blue', 'g1')).toBe(true)
    expect(fga.has(DIDS.redSpymaster, 'active_clue_giver', 'g1')).toBe(true)
    expect(fga.has(DIDS.redOperative, 'active_guesser', 'g1')).toBe(true)
    expect(fga.has(DIDS.blueSpymaster, 'active_clue_giver', 'g1')).toBe(false)
  })

  it('deals the seeded board deterministically (scripted fallback contract)', () => {
    expect(store.get('g1')!.state.board).toEqual(reference.board)
  })
})

describe('beat 1 — on-turn clue is accepted', () => {
  it('red spymaster clues on red turn → 200, accepted event, team derived from turn', async () => {
    const res = await post('/games/g1/clue', 'red-spymaster', { word: 'melody', count: 2 })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.outcome).toBe('accepted')
    expect(body.state.currentClue).toEqual({ word: 'MELODY', count: 2, team: 'red' })
    const events = store.get('g1')!.events
    expect(events.at(-1)).toMatchObject({ kind: 'clue', actor: DIDS.redSpymaster, outcome: 'accepted' })
  })
})

describe('beat 2 — off-turn clue is denied by FGA', () => {
  it('blue spymaster clues on red turn → 403 denied_authz, denial is an audit event', async () => {
    const res = await post('/games/g1/clue', 'blue-spymaster', { word: 'sneaky', count: 3 })
    expect(res.statusCode).toBe(403)
    expect(res.json().outcome).toBe('denied_authz')
    expect(store.get('g1')!.events.at(-1)).toMatchObject({
      kind: 'clue',
      actor: DIDS.blueSpymaster,
      outcome: 'denied_authz',
    })
    // the attempt changed nothing
    expect(store.get('g1')!.state.phase).toBe('awaiting_clue')
  })
})

describe('beat 3 — key card is role-scoped', () => {
  it('operative requests the key → 403 with a key_peek audit event', async () => {
    const res = await get('/games/g1/key', 'red-operative')
    expect(res.statusCode).toBe(403)
    expect(store.get('g1')!.events.at(-1)).toMatchObject({
      kind: 'key_peek',
      actor: DIDS.redOperative,
      outcome: 'denied_authz',
    })
  })

  it('spymaster (either team, any time) gets the full key', async () => {
    const res = await get('/games/g1/key', 'blue-spymaster')
    expect(res.statusCode).toBe(200)
    const key = res.json().key
    expect(key).toHaveLength(25)
    expect(key.every((c: { cardType?: string }) => c.cardType)).toBe(true)
  })
})

describe('beat 4 — separation of duties', () => {
  it('red spymaster (who knows the key) tries to guess → 403 denied_authz', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    const res = await post('/games/g1/guess', 'red-spymaster', { word: wordOfType('red') })
    expect(res.statusCode).toBe(403)
    expect(res.json().outcome).toBe('denied_authz')
  })
})

describe('beat 5 — federation grants voice, not authority', () => {
  it('an authenticated foreign-PDS agent with no tuples → 403 denied_authz', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    const res = await post('/games/g1/guess', 'guest', { word: wordOfType('red') })
    expect(res.statusCode).toBe(403)
    expect(store.get('g1')!.events.at(-1)).toMatchObject({ actor: DIDS.guest, outcome: 'denied_authz' })
  })

  it('no token at all → 401, and unauthenticated attempts are not game events', async () => {
    const res = await post('/games/g1/guess', null, { word: wordOfType('red') })
    expect(res.statusCode).toBe(401)
    expect(store.get('g1')!.events.filter((e) => e.kind === 'guess')).toHaveLength(0)
  })

  it('the stretch beat: one tuple grant turns the rogue into a legal player', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    await fga.transitionTurn('g1', { grant: { guesser: DIDS.guest } }) // the on-stage grant
    const res = await post('/games/g1/guess', 'guest', { word: wordOfType('red') })
    expect(res.statusCode).toBe(200)
    expect(res.json().outcome).toBe('accepted')
  })
})

describe('rules layer stays distinct from authz (denied_rules)', () => {
  it('authorized guesser moving in the wrong phase → 422 denied_rules', async () => {
    // at game start the red operative holds active_guesser, but no clue exists yet
    const res = await post('/games/g1/guess', 'red-operative', { word: wordOfType('red') })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.outcome).toBe('denied_rules')
    expect(body.code).toBe('wrong_phase')
    expect(store.get('g1')!.events.at(-1)).toMatchObject({ outcome: 'denied_rules' })
  })
})

describe('turn transitions move authority', () => {
  it('pass hands the ephemeral tuples to the other team', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    const res = await post('/games/g1/pass', 'red-operative')
    expect(res.statusCode).toBe(200)
    expect(fga.has(DIDS.redSpymaster, 'active_clue_giver', 'g1')).toBe(false)
    expect(fga.has(DIDS.redOperative, 'active_guesser', 'g1')).toBe(false)
    expect(fga.has(DIDS.blueSpymaster, 'active_clue_giver', 'g1')).toBe(true)
    expect(fga.has(DIDS.blueOperative, 'active_guesser', 'g1')).toBe(true)
  })

  it('game end revokes the turn tuples and grants nothing', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    const res = await post('/games/g1/guess', 'red-operative', { word: wordOfType('assassin') })
    expect(res.statusCode).toBe(200)
    expect(res.json().state.winner).toBe('blue')
    for (const did of Object.values(ROLES)) {
      expect(fga.has(did, 'active_clue_giver', 'g1')).toBe(false)
      expect(fga.has(did, 'active_guesser', 'g1')).toBe(false)
    }
    expect(store.get('g1')!.events.at(-1)).toMatchObject({ kind: 'game_end', outcome: 'accepted' })
  })
})

describe('authority moves before state becomes visible', () => {
  it('a failed tuple transition aborts the move — state and tuples never diverge', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    fga.transitionTurn = async () => {
      throw new Error('FGA unreachable')
    }
    const res = await post('/games/g1/pass', 'red-operative') // pass flips the turn
    expect(res.statusCode).toBe(500)
    const state = store.get('g1')!.state
    expect(state.turn).toBe('red') // NOT committed
    expect(state.phase).toBe('awaiting_guesses')
    expect(store.get('g1')!.events.filter((e) => e.kind === 'pass')).toHaveLength(0)
  })
})

describe('public surfaces', () => {
  it('game state is public and never leaks unrevealed card types', async () => {
    await post('/games/g1/clue', 'red-spymaster', { word: 'valid', count: 2 })
    await post('/games/g1/guess', 'red-operative', { word: wordOfType('red') })
    const res = await get('/games/g1') // no token
    expect(res.statusCode).toBe(200)
    const board = res.json().board as Array<{ revealed: boolean; cardType?: string }>
    expect(board.filter((c) => !c.revealed).every((c) => c.cardType === undefined)).toBe(true)
    expect(board.some((c) => c.revealed && c.cardType === 'red')).toBe(true)
  })

  it('the event log is public — the audit trail is the product', async () => {
    await post('/games/g1/clue', 'blue-spymaster', { word: 'sneaky', count: 1 }) // denied
    const res = await get('/games/g1/events')
    expect(res.statusCode).toBe(200)
    const events = res.json().events
    expect(events[0]).toMatchObject({ kind: 'game_start' })
    expect(events.at(-1)).toMatchObject({ kind: 'clue', outcome: 'denied_authz' })
  })
})
