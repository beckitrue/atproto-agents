/**
 * Typed client for the game engine HTTP API. Move calls return a
 * discriminated result rather than throwing on 403/422 — denials are
 * expected, first-class outcomes in this system, not exceptions.
 */
import type { Card, ClueRef, Phase, Team } from '@atproto-agents/lexicon'
import type { KeyCard } from './brain.js'
import type { TokenProvider } from './token.js'

export interface PublicState {
  id: string
  turn: Team
  phase: Phase
  board: Card[]
  currentClue: ClueRef | null
  winner: Team | null
  winReason: string | null
}

export type MoveResult =
  | { outcome: 'accepted'; state: PublicState }
  | { outcome: 'denied_authz' | 'denied_rules'; status: number; detail: string; code?: string }

/** What the runner needs from the engine — fakeable in tests. */
export interface EngineApi {
  state(gameId: string): Promise<PublicState>
  key(gameId: string): Promise<KeyCard[]>
  clue(gameId: string, word: string, count: number): Promise<MoveResult>
  guess(gameId: string, word: string): Promise<MoveResult>
  pass(gameId: string): Promise<MoveResult>
}

export class EngineClient implements EngineApi {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenProvider,
  ) {}

  private async request(method: string, path: string, opts: { auth?: boolean; body?: unknown } = {}) {
    const headers: Record<string, string> = {}
    if (opts.auth) headers.authorization = `Bearer ${await this.tokens.get()}`
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    return { status: res.status, body: await res.json() }
  }

  async state(gameId: string): Promise<PublicState> {
    const { status, body } = await this.request('GET', `/games/${gameId}`)
    if (status !== 200) throw new Error(`GET state failed: ${status} ${JSON.stringify(body)}`)
    return body as PublicState
  }

  /** Spymasters only — 403 for anyone else (demo beat 3). */
  async key(gameId: string): Promise<KeyCard[]> {
    const { status, body } = await this.request('GET', `/games/${gameId}/key`, { auth: true })
    if (status !== 200) throw new Error(`GET key failed: ${status} ${JSON.stringify(body)}`)
    return (body as { key: KeyCard[] }).key
  }

  private asMoveResult({ status, body }: { status: number; body: any }): MoveResult {
    if (status === 200) return { outcome: 'accepted', state: body.state }
    if (status === 403 || status === 422) {
      return { outcome: body.outcome, status, detail: body.detail ?? body.error, code: body.code }
    }
    throw new Error(`move failed: ${status} ${JSON.stringify(body)}`)
  }

  async clue(gameId: string, word: string, count: number): Promise<MoveResult> {
    return this.asMoveResult(
      await this.request('POST', `/games/${gameId}/clue`, { auth: true, body: { word, count } }),
    )
  }

  async guess(gameId: string, word: string): Promise<MoveResult> {
    return this.asMoveResult(
      await this.request('POST', `/games/${gameId}/guess`, { auth: true, body: { word } }),
    )
  }

  async pass(gameId: string): Promise<MoveResult> {
    return this.asMoveResult(await this.request('POST', `/games/${gameId}/pass`, { auth: true, body: {} }))
  }
}
