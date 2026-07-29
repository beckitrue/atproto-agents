/**
 * Observer UI — what the audience watches, at observer.<domain>.
 *
 * Three columns, and the separation between the last two is the argument:
 *
 *   1. The board — public state; the key stays hidden until cards reveal
 *   2. DECISION LOG — what the ENGINE did. Every attempt, colour-coded by
 *      outcome: accepted / denied_authz (FGA) / denied_rules.
 *   3. AT PROTO FIREHOSE — what AGENTS said. Read from Jetstream by the
 *      browser itself, with no help from our server.
 *
 * The same denial appearing in both right-hand columns is corroboration from
 * two independent sources; a move in column 3 with no matching acceptance in
 * column 2 is speech without authority. See docs/OBSERVER.md.
 *
 * Columns 1–2 read the engine's public endpoints via the same-origin /api
 * proxy. Column 3 needs no backend and keeps working when the engine is down.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useFirehose } from './firehose.js'
import type { FirehoseRow } from './firehose.js'
import { ROSTER } from './roster.js'

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

const params = new URLSearchParams(location.search)
/**
 * `?game=<id>` pins a specific game (what the demo driver uses). With no
 * query string — how the public URL is reached — we ask the engine for the
 * most recently active game.
 */
const requestedGame = params.get('game')
/** `?feed=roster` hides unrecognized DIDs outright. The stage escape hatch. */
const rosterOnly = params.get('feed') === 'roster'

const TEAM = { red: '#e05252', blue: '#4d8fd6' } as const
const C = {
  bg: '#141821',
  panel: '#1b202b',
  card: '#232936',
  line: '#333a46',
  text: '#d7dde8',
  muted: '#9aa4b5',
  dim: '#697386',
  ok: '#7bc47b',
  warn: '#e0a03d',
  danger: '#e05252',
}

function cardStyle(card: Card): CSSProperties {
  const base: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '0.5rem 0.25rem',
    minHeight: '3.4rem',
    borderRadius: 8,
    fontWeight: 700,
    letterSpacing: '0.03em',
    fontSize: 'clamp(0.75rem, 1.35vw, 1.6rem)',
    border: `1px solid ${C.line}`,
    background: C.card,
    color: C.text,
  }
  if (!card.revealed) return base
  switch (card.cardType) {
    case 'red':
      return { ...base, background: '#7c2020', borderColor: '#a33', color: '#ffd9d9' }
    case 'blue':
      return { ...base, background: '#1e4570', borderColor: TEAM.blue, color: '#d6e8ff' }
    case 'bystander':
      return { ...base, background: '#8a7d5c', borderColor: '#b0a37e', color: '#2a2517' }
    case 'assassin':
      return { ...base, background: '#000', borderColor: '#666', color: '#fff' }
    default:
      return base
  }
}

const OUTCOME: Record<GameEvent['outcome'], { color: string; mark: string }> = {
  accepted: { color: C.ok, mark: '✅' },
  denied_authz: { color: C.danger, mark: '⛔' },
  denied_rules: { color: C.warn, mark: '⛔' },
}

/** did:plc:xyz… → the seated agent's name, or a short DID for a stranger. */
const actorName = (actor: string) =>
  ROSTER[actor]?.label ?? (actor.startsWith('did:') ? `…${actor.slice(-8)}` : actor)

export function App() {
  const [gameId, setGameId] = useState<string | null>(requestedGame)
  const [state, setState] = useState<GameState | null>(null)
  const [events, setEvents] = useState<GameEvent[]>([])
  const [engineError, setEngineError] = useState<string | null>(null)
  const [showStrangers, setShowStrangers] = useState(false)

  const firehose = useFirehose(gameId, rosterOnly)

  // Keep asking until a game exists: the page is often open on the projector
  // before the driver runs new-game.mjs.
  useEffect(() => {
    if (gameId) return
    let live = true
    const find = async () => {
      try {
        const res = await fetch('/api/games').then((r) => r.json())
        if (!live) return
        const next = res.games?.[0]?.id
        if (next) setGameId(next)
        setEngineError(null)
      } catch (err) {
        if (live) setEngineError((err as Error).message)
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
        // The engine's store is in-memory, so a restart mid-talk makes this
        // 404 with {"error":"game not found"} while we still hold the id.
        // Rendering that blindly crashes on state.turn and white-screens the
        // projector, so treat anything that isn't a board as "game is gone"
        // and fall back to discovery.
        if (!s || !Array.isArray(s.board)) {
          setState(null)
          setEvents([])
          setEngineError(s?.error ?? 'game not found')
          if (!requestedGame) setGameId(null)
          return
        }
        setState(s)
        setEvents(Array.isArray(e?.events) ? e.events : [])
        setEngineError(null)
      } catch (err) {
        if (live) setEngineError((err as Error).message)
      }
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [gameId])

  const visibleRows = firehose.rows.filter((r) => r.seated || showStrangers)

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        background: C.bg,
        color: C.text,
        height: '100vh',
        boxSizing: 'border-box',
        padding: '0.9rem 1.1rem',
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gap: '0.8rem',
      }}
    >
      <Header state={state} gameId={gameId} engineError={engineError} status={firehose.status} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 40fr) minmax(0, 30fr) minmax(0, 30fr)',
          gap: '0.8rem',
          minHeight: 0,
        }}
      >
        <Panel fill>
          {state ? (
            // Fills the column: the board is the thing read from the back of
            // the room, so it takes every pixel the layout can give it.
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                gridTemplateRows: 'repeat(5, minmax(0, 1fr))',
                gap: 8,
                height: '100%',
              }}
            >
              {state.board.map((c) => (
                <div key={c.word} style={cardStyle(c)}>
                  {c.word}
                </div>
              ))}
            </div>
          ) : (
            <Empty>{engineError ? 'engine unreachable' : 'waiting for a game to start…'}</Empty>
          )}
        </Panel>

        <Panel title="Decision log" subtitle="what the engine did">
          {events.length === 0 ? (
            <Empty>{engineError ? `engine unreachable — ${engineError}` : 'no events yet'}</Empty>
          ) : (
            [...events].reverse().map((e, i) => (
              <div key={events.length - i} style={{ marginBottom: '0.55rem', lineHeight: 1.35 }}>
                <div style={{ fontSize: '0.78rem' }}>
                  <span style={{ color: C.dim }}>{new Date(e.at).toLocaleTimeString()}</span>{' '}
                  <b>{e.kind}</b>{' '}
                  <span style={{ color: OUTCOME[e.outcome]?.color ?? C.muted, fontWeight: 700 }}>
                    {OUTCOME[e.outcome]?.mark} {e.outcome}
                  </span>
                </div>
                <div style={{ fontSize: '0.78rem', color: C.muted }}>{actorName(e.actor)}</div>
                {e.detail && (
                  <div style={{ fontSize: '0.72rem', color: C.dim }}>{e.detail}</div>
                )}
              </div>
            ))
          )}
        </Panel>

        <Panel title="AT Proto firehose" subtitle="what agents said">
          {!rosterOnly && firehose.strangers.records > 0 && (
            <button
              onClick={() => setShowStrangers((v) => !v)}
              style={{
                width: '100%',
                textAlign: 'left',
                marginBottom: '0.6rem',
                padding: '0.4rem 0.5rem',
                borderRadius: 6,
                border: `1px solid ${C.warn}`,
                background: 'transparent',
                color: C.warn,
                fontSize: '0.75rem',
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              ⚠ {firehose.strangers.records} record
              {firehose.strangers.records === 1 ? '' : 's'} from {firehose.strangers.dids}{' '}
              unrecognized DID{firehose.strangers.dids === 1 ? '' : 's'} —{' '}
              {showStrangers ? 'hide' : 'show'}
            </button>
          )}
          {visibleRows.length === 0 ? (
            <Empty>listening for agent records…</Empty>
          ) : (
            visibleRows.map((r) => <Row key={r.key} row={r} />)
          )}
        </Panel>
      </div>
    </main>
  )
}

function Header({
  state,
  gameId,
  engineError,
  status,
}: {
  state: GameState | null
  gameId: string | null
  engineError: string | null
  status: string
}) {
  // 'polling' must look different from 'live': the column still updates, but
  // on an 8s timer rather than instantly, and pretending otherwise would make
  // a stale projector look current.
  const FALLBACK = { color: C.dim, label: 'firehose connecting…' }
  const LOOK: Record<string, { color: string; label: string }> = {
    live: { color: C.ok, label: 'firehose live' },
    polling: { color: C.warn, label: 'firehose polling (no live feed)' },
    frozen: { color: C.warn, label: 'firehose frozen — press f' },
    connecting: { color: C.dim, label: 'firehose connecting…' },
    error: { color: C.danger, label: 'firehose unavailable' },
  }
  const look = LOOK[status] ?? FALLBACK
  return (
    <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
      <h1 style={{ margin: 0, fontSize: '1.25rem' }}>
        Codenames <span style={{ color: C.muted }}>— {gameId ?? 'no game'}</span>
      </h1>
      {state?.winner ? (
        <span style={{ color: TEAM[state.winner], fontWeight: 700 }}>
          {state.winner.toUpperCase()} WINS — {state.winReason}
        </span>
      ) : state ? (
        <span>
          <b style={{ color: TEAM[state.turn] }}>{state.turn.toUpperCase()}</b>
          &nbsp;·&nbsp;{state.phase.replace('_', ' ')}
          {state.currentClue && (
            <>
              &nbsp;·&nbsp;clue:&nbsp;
              <b style={{ color: TEAM[state.currentClue.team] }}>
                “{state.currentClue.word}” for {state.currentClue.count}
              </b>
            </>
          )}
        </span>
      ) : (
        <span style={{ color: C.dim }}>{engineError ? 'engine unreachable' : 'waiting…'}</span>
      )}
      <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: C.dim }}>
        <span style={{ color: look.color }}>●</span> {look.label}
      </span>
    </header>
  )
}

function Row({ row }: { row: FirehoseRow }) {
  const seat = ROSTER[row.did]
  const color = row.team ? TEAM[row.team] : C.muted

  if (row.kind === 'denial') {
    return (
      <div style={{ marginBottom: '0.6rem', lineHeight: 1.35 }}>
        <div style={{ fontSize: '0.78rem', color: C.danger, fontWeight: 700 }}>🚨 DENIED</div>
        <div style={{ fontSize: '0.72rem', color: C.muted }}>{row.detail}</div>
        <Provenance row={row} label="referee · gameState" />
      </div>
    )
  }

  const deliberating = row.kind === 'deliberate'
  const verb = deliberating
    ? row.stance === 'support'
      ? 'backs'
      : row.stance === 'object'
        ? 'objects to'
        : 'proposes'
    : row.kind === 'clue'
      ? 'clues'
      : row.kind === 'guess'
        ? 'guesses'
        : 'passes'
  return (
    <div style={{ marginBottom: '0.6rem', lineHeight: 1.35 }}>
      <div style={{ fontSize: '0.8rem' }}>
        <span style={{ color }}>{row.team === 'blue' ? '🔵' : row.team === 'red' ? '🔴' : '⬚'}</span>{' '}
        <b style={{ color: row.seated ? C.text : C.warn }}>
          {seat?.label ?? `unrecognized …${row.did.slice(-6)}`}
        </b>{' '}
        {/* Deliberation is talk, not a move — mark it so the audience never
            mistakes an argument for a committed guess. */}
        {deliberating && <span title="deliberation — not a committed move">💬 </span>}
        <span style={{ color: C.muted }}>{verb}</span>
        {row.word && <b> “{row.word}”</b>}
        {row.count !== undefined && <span style={{ color: C.muted }}> for {row.count}</span>}
      </div>
      {row.reasoning && (
        <div style={{ fontSize: '0.72rem', color: C.dim }}>💭 {row.reasoning}</div>
      )}
      <Provenance row={row} label={`${row.kind} record`} />
    </div>
  )
}

/** Every row says where it came from — the column's whole claim is provenance. */
function Provenance({ row, label }: { row: FirehoseRow; label: string }) {
  return (
    <div style={{ fontSize: '0.66rem', color: C.dim }}>
      ⛓ {label} · {new Date(row.at).toLocaleTimeString()}
      {row.game && ` · ${row.game}`}
    </div>
  )
}

function Panel({
  title,
  subtitle,
  fill,
  children,
}: {
  title?: string
  subtitle?: string
  /** Content sizes itself to the panel instead of scrolling (the board). */
  fill?: boolean
  children: ReactNode
}) {
  return (
    <section
      style={{
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: '0.75rem 0.85rem',
        overflowY: fill ? 'hidden' : 'auto',
        minHeight: 0,
        ...(fill ? { display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' } : {}),
      }}
    >
      {title && (
        <div style={{ marginBottom: '0.6rem' }}>
          <h2 style={{ margin: 0, fontSize: '0.95rem' }}>{title}</h2>
          <div style={{ fontSize: '0.72rem', color: C.dim }}>{subtitle}</div>
        </div>
      )}
      {children}
    </section>
  )
}

const Empty = ({ children }: { children: ReactNode }) => (
  <div style={{ color: C.dim, fontSize: '0.8rem' }}>{children}</div>
)
