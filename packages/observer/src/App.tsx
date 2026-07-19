/**
 * Observer UI — what the audience watches.
 *   1. The board (public state; the key stays hidden until cards reveal)
 *   2. The current clue + game status
 *   3. The decision log: every attempt, color-coded by outcome —
 *      accepted / denied_authz (FGA) / denied_rules. Denials are the demo.
 *
 * Reads the engine's public endpoints via the dev proxy (/api → engine).
 * Pass the game id as ?game=<id>.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

interface Card {
  word: string
  revealed: boolean
  cardType?: 'red' | 'blue' | 'bystander' | 'assassin'
}
interface ClueRef {
  word: string
  count: number
  team: 'red' | 'blue'
}
interface GameState {
  id: string
  turn: 'red' | 'blue'
  phase: string
  board: Card[]
  currentClue: ClueRef | null
  winner: 'red' | 'blue' | null
  winReason: string | null
}
interface GameEvent {
  kind: string
  actor: string
  outcome: 'accepted' | 'denied_authz' | 'denied_rules'
  detail?: string
  at: string
}

/**
 * `?game=<id>` pins a specific game (what the demo driver uses). With no
 * query string — how the public URL is reached — we ask the engine for the
 * most recently active game, so an attendee just opens observer.<domain>.
 */
const requestedGame = new URLSearchParams(location.search).get('game')

const TEAM_COLOR = { red: '#e05252', blue: '#4d8fd6' } as const

function cardStyle(card: Card): CSSProperties {
  const base: CSSProperties = {
    padding: '1.1rem 0.4rem',
    borderRadius: 8,
    textAlign: 'center',
    fontWeight: 600,
    letterSpacing: '0.04em',
    fontSize: '0.85rem',
    border: '1px solid #333a46',
    background: '#232936',
    color: '#d7dde8',
  }
  if (!card.revealed) return base
  switch (card.cardType) {
    case 'red':
      return { ...base, background: '#7c2020', borderColor: '#a33', color: '#ffd9d9' }
    case 'blue':
      return { ...base, background: '#1e4570', borderColor: '#4d8fd6', color: '#d6e8ff' }
    case 'bystander':
      return { ...base, background: '#8a7d5c', borderColor: '#b0a37e', color: '#2a2517' }
    case 'assassin':
      return { ...base, background: '#000', borderColor: '#666', color: '#fff' }
    default:
      return base
  }
}

const OUTCOME_STYLE: Record<GameEvent['outcome'], CSSProperties> = {
  accepted: { color: '#7bc47b' },
  denied_authz: { color: '#e05252', fontWeight: 700 },
  denied_rules: { color: '#e0a03d', fontWeight: 700 },
}

/** did:plc:xyz… → xyz… (short); handles map lands with the week-3 polish */
const shortActor = (actor: string) =>
  actor.startsWith('did:') ? `…${actor.slice(-8)}` : actor

export function App() {
  const [gameId, setGameId] = useState<string | null>(requestedGame)
  const [state, setState] = useState<GameState | null>(null)
  const [events, setEvents] = useState<GameEvent[]>([])
  const [error, setError] = useState<string | null>(null)

  // Keep asking until a game exists: the page is often open on the projector
  // before the driver runs new-game.mjs, and it should pick the game up by
  // itself rather than needing a reload mid-talk.
  useEffect(() => {
    if (gameId) return
    let live = true
    const find = async () => {
      try {
        const res = await fetch('/api/games').then((r) => r.json())
        if (!live) return
        const next = res.games?.[0]?.id
        if (next) setGameId(next)
        setError(null)
      } catch (err) {
        if (live) setError((err as Error).message)
      }
    }
    find()
    const id = setInterval(find, 3000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [gameId])

  useEffect(() => {
    if (!gameId) return
    let live = true
    const tick = async () => {
      try {
        const [s, e] = await Promise.all([
          fetch(`/api/games/${gameId}`).then((r) => r.json()),
          fetch(`/api/games/${gameId}/events`).then((r) => r.json()),
        ])
        if (!live) return
        setState(s)
        setEvents(e.events ?? [])
        setError(null)
      } catch (err) {
        if (live) setError((err as Error).message)
      }
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [gameId])

  if (!gameId) {
    return (
      <Shell>{error ? `engine unreachable: ${error}` : 'waiting for a game to start…'}</Shell>
    )
  }
  if (!state) {
    return <Shell>{error ? `engine unreachable: ${error}` : 'loading…'}</Shell>
  }

  return (
    <Shell>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Codenames — {state.id}</h1>
        {state.winner ? (
          <span style={{ color: TEAM_COLOR[state.winner], fontWeight: 700 }}>
            {state.winner.toUpperCase()} WINS — {state.winReason}
          </span>
        ) : (
          <span>
            <b style={{ color: TEAM_COLOR[state.turn] }}>{state.turn.toUpperCase()}</b>
            &nbsp;·&nbsp;{state.phase.replace('_', ' ')}
            {state.currentClue && (
              <>
                &nbsp;·&nbsp;clue:&nbsp;
                <b style={{ color: TEAM_COLOR[state.currentClue.team] }}>
                  “{state.currentClue.word}” for {state.currentClue.count}
                </b>
              </>
            )}
          </span>
        )}
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 8,
          margin: '1.2rem 0',
        }}
      >
        {state.board.map((c) => (
          <div key={c.word} style={cardStyle(c)}>
            {c.word}
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: '1rem', color: '#9aa4b5', margin: '0 0 0.5rem' }}>
        Decision log — every attempt, including denials
      </h2>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', lineHeight: 1.7 }}>
        {[...events].reverse().map((e, i) => (
          <div key={events.length - i}>
            <span style={{ color: '#697386' }}>{new Date(e.at).toLocaleTimeString()}</span>{' '}
            <span style={{ display: 'inline-block', width: '6.5em' }}>{e.kind}</span>
            <span style={{ ...OUTCOME_STYLE[e.outcome], display: 'inline-block', width: '9em' }}>
              {e.outcome}
            </span>{' '}
            <span style={{ color: '#9aa4b5' }}>{shortActor(e.actor)}</span>
            {e.detail && <span style={{ color: '#697386' }}> — {e.detail}</span>}
          </div>
        ))}
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        background: '#141821',
        color: '#d7dde8',
        minHeight: '100vh',
        padding: '1.5rem 2rem',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </main>
  )
}
