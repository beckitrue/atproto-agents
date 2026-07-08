/**
 * HTTP API — where authentication, authorization, and rules meet.
 *
 * Every move endpoint runs the same sequence:
 *   1. AUTHENTICATE  — verify the Auth0 token, extract the agent's DID
 *   2. AUTHORIZE     — FGA check; denial => 403 + `denied_authz` event
 *   3. VALIDATE      — game rules; violation => 422 + `denied_rules` event
 *   4. COMMIT        — apply move, transition turn tuples, record event
 *
 * Denials are recorded as first-class events, not just errors — the demo
 * (and the argument) depends on the audit trail being visible.
 */
import type { FastifyInstance } from 'fastify'
import type { EventKind } from '@atproto-agents/lexicon'
import { GameRuleError, createGame, giveClue, guess, pass, publicBoard, seededRng } from './game.js'
import { WORDS } from './wordlist.js'
import type { AuthorizerApi, Permission, RoleAssignments } from './fga.js'
import { turnHolders } from './fga.js'
import type { AgentIdentity } from './auth.js'
import { AuthError } from './auth.js'
import type { GameStore, StoredGame } from './store.js'

export interface RouteDeps {
  store: GameStore
  authorizer: AuthorizerApi
  verifyBearer: (header: string | undefined) => Promise<AgentIdentity>
  /** Called after every event so the referee can publish to AT Proto (week 2). */
  onEvent?: (game: StoredGame) => void
}

type MoveKind = 'clue' | 'guess' | 'pass'

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, authorizer, verifyBearer } = deps

  const record = (
    game: StoredGame,
    kind: EventKind,
    actor: string,
    outcome: 'accepted' | 'denied_authz' | 'denied_rules',
    detail?: string,
  ) => {
    game.events.push({ kind, actor, outcome, detail, at: new Date().toISOString() })
    deps.onEvent?.(game)
  }

  /**
   * Shared move pipeline: authenticate → authorize → validate → commit.
   *
   * Note the mover's team is never taken from the request: the ephemeral
   * FGA tuples are only ever granted to the on-turn team's agents, so any
   * FGA-authorized move is by construction a move for `state.turn`. This
   * also keeps the live-grant stretch beat open — a guest agent granted a
   * turn tuple can act without a seat in the standing roster.
   */
  const handleMove = async (
    gameId: string,
    authHeader: string | undefined,
    kind: MoveKind,
    permission: Permission,
    apply: (game: StoredGame) => void,
  ) => {
    const identity = await verifyBearer(authHeader) // throws AuthError → 401
    const game = store.get(gameId)
    if (!game) return { status: 404 as const, body: { error: 'game not found' } }

    // 2. AUTHORIZE — the FGA check. This is the enforcement point.
    const allowed = await authorizer.check(identity.did, permission, gameId)
    if (!allowed) {
      record(game, kind, identity.did, 'denied_authz', `${identity.did} lacks ${permission}`)
      return {
        status: 403 as const,
        body: {
          error: 'not authorized',
          outcome: 'denied_authz',
          detail: `FGA: ${identity.did} does not hold ${permission} on game:${gameId}`,
        },
      }
    }

    // 3+4. VALIDATE and COMMIT
    const before = game.state.turn
    try {
      apply(game)
    } catch (err) {
      if (err instanceof GameRuleError) {
        record(game, kind, identity.did, 'denied_rules', err.message)
        return {
          status: 422 as const,
          body: { error: 'illegal move', outcome: 'denied_rules', code: err.code, detail: err.message },
        }
      }
      throw err
    }
    record(game, kind, identity.did, 'accepted')

    // Turn changed → move the ephemeral FGA tuples. The on-stage moment.
    if (game.state.phase === 'finished') {
      const holders = turnHolders(game.roles, before)
      await authorizer.transitionTurn(gameId, { revoke: holders, grant: {} })
      record(game, 'game_end', 'referee', 'accepted', game.state.winReason ?? undefined)
    } else if (game.state.turn !== before) {
      await authorizer.transitionTurn(gameId, {
        revoke: turnHolders(game.roles, before),
        grant: turnHolders(game.roles, game.state.turn),
      })
    }
    return { status: 200 as const, body: { outcome: 'accepted', state: publicState(game) } }
  }

  // --- Routes ---

  app.post<{ Body: { id: string; roles: RoleAssignments; seed?: number } }>(
    '/games',
    async (req, reply) => {
      // Game creation is the operator's action (demo driver), not an agent move.
      // TODO(week 2): protect with an operator token.
      const { id, roles, seed } = req.body
      if (store.get(id)) return reply.status(409).send({ error: 'game exists' })
      const state = createGame(id, WORDS, seed !== undefined ? { rng: seededRng(seed) } : {})
      const game = store.create(state, roles)
      await authorizer.assignRoles(id, roles)
      await authorizer.transitionTurn(id, { grant: turnHolders(roles, state.turn) })
      record(game, 'game_start', 'referee', 'accepted', `${state.turn} goes first`)
      return reply.send({ outcome: 'accepted', state: publicState(game) })
    },
  )

  app.post<{ Params: { id: string }; Body: { word: string; count: number } }>(
    '/games/:id/clue',
    async (req, reply) => {
      const { status, body } = await handleMove(
        req.params.id,
        req.headers.authorization,
        'clue',
        'can_give_clue',
        (game) => {
          game.state = giveClue(game.state, game.state.turn, req.body.word, req.body.count)
        },
      )
      return reply.status(status).send(body)
    },
  )

  app.post<{ Params: { id: string }; Body: { word: string } }>(
    '/games/:id/guess',
    async (req, reply) => {
      const { status, body } = await handleMove(
        req.params.id,
        req.headers.authorization,
        'guess',
        'can_guess',
        (game) => {
          game.state = guess(game.state, game.state.turn, req.body.word)
        },
      )
      return reply.status(status).send(body)
    },
  )

  app.post<{ Params: { id: string } }>('/games/:id/pass', async (req, reply) => {
    const { status, body } = await handleMove(
      req.params.id,
      req.headers.authorization,
      'pass',
      'can_guess',
      (game) => {
        game.state = pass(game.state, game.state.turn)
      },
    )
    return reply.status(status).send(body)
  })

  /** Public game state — no auth needed; transparency is the point. */
  app.get<{ Params: { id: string } }>('/games/:id', async (req, reply) => {
    const game = store.get(req.params.id)
    if (!game) return reply.status(404).send({ error: 'game not found' })
    return reply.send(publicState(game))
  })

  /** The key card — spymasters only. Demo beat 3 targets this. */
  app.get<{ Params: { id: string } }>('/games/:id/key', async (req, reply) => {
    const identity = await verifyBearer(req.headers.authorization)
    const game = store.get(req.params.id)
    if (!game) return reply.status(404).send({ error: 'game not found' })
    const allowed = await authorizer.check(identity.did, 'can_view_key', req.params.id)
    if (!allowed) {
      record(game, 'key_peek', identity.did, 'denied_authz', `${identity.did} attempted to view the key card`)
      return reply.status(403).send({
        error: 'not authorized',
        outcome: 'denied_authz',
        detail: `FGA: ${identity.did} does not hold can_view_key on game:${req.params.id}`,
      })
    }
    return reply.send({ key: game.state.board })
  })

  /** Event log — the audit trail the observer UI renders. */
  app.get<{ Params: { id: string } }>('/games/:id/events', async (req, reply) => {
    const game = store.get(req.params.id)
    if (!game) return reply.status(404).send({ error: 'game not found' })
    return reply.send({ events: game.events })
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      return reply.status(401).send({ error: 'unauthenticated', detail: err.message })
    }
    app.log.error(err)
    return reply.status(500).send({ error: 'internal error' })
  })
}

function publicState(game: StoredGame) {
  const s = game.state
  return {
    id: s.id,
    turn: s.turn,
    phase: s.phase,
    board: publicBoard(s),
    currentClue: s.currentClue,
    winner: s.winner,
    winReason: s.winReason,
  }
}
