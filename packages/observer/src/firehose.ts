/**
 * The AT Proto column: what agents SAID, read straight off the network.
 *
 * No backend. The browser subscribes to Jetstream itself, filtered by
 * collection and NOT by DID, so any agent anywhere writing our lexicon shows
 * up unprompted — including a guest on a PDS we've never heard of. That the
 * audience can read this without our cooperation is the point.
 *
 * Which also makes this column an unauthenticated render target for
 * strangers, projected on a wall. We can't stop anyone writing these records
 * and don't pretend to; we curate the view instead. See docs/OBSERVER.md.
 */
import { useEffect, useRef, useState } from 'react'
import { PDS_URL, PLAYER_DIDS, REFEREE_DID, ROSTER } from './roster.js'

const JETSTREAM = 'wss://jetstream2.us-east.bsky.network/subscribe'
const NSID_PREFIX = 'com.beckitrue.codenames.'
const MOVE_COLLECTIONS = ['clue', 'guess', 'pass'].map((k) => NSID_PREFIX + k)

/** Bounds memory no matter what arrives. */
const MAX_ROWS = 200
/** Rendered rows one unrecognized DID may occupy before it only counts. */
const MAX_ROWS_PER_STRANGER = 3
const MAX_REASONING = 220

export interface FirehoseRow {
  key: string
  did: string
  at: string
  game: string
  seated: boolean
  /** Move rows carry a kind; referee rows are denials. */
  kind: 'clue' | 'guess' | 'pass' | 'denial'
  team?: 'red' | 'blue'
  word?: string
  count?: number
  /** Only ever populated for seated agents — the injection vector. */
  reasoning?: string
  detail?: string
}

export interface FirehoseState {
  rows: FirehoseRow[]
  /** Unrecognized DIDs seen, and how many records they wrote. */
  strangers: { dids: number; records: number }
  status: 'connecting' | 'live' | 'frozen' | 'error'
}

/**
 * Free text from strangers lands on a projector, so: no control characters
 * (which can reorder or hide text), no newlines, hard length cap.
 */
function sanitize(text: unknown, max = MAX_REASONING): string | undefined {
  if (typeof text !== 'string') return undefined
  const flat = text
    // C0/C1 controls (incl. newlines), zero-width and bidi marks — the last
    // of these can visually reorder or conceal text on a projector.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const team = (v: unknown): 'red' | 'blue' | undefined =>
  v === 'red' || v === 'blue' ? v : undefined

/** One repo record → at most one row. Returns null for anything we won't show. */
export function toRow(
  did: string,
  collection: string,
  record: Record<string, any>,
  key: string,
  gameId: string | null,
): FirehoseRow | null {
  const game = typeof record?.game === 'string' ? record.game : ''
  // With the engine unreachable we don't know the current game — show
  // everything rather than nothing, and let each row name its own game.
  if (gameId && game !== gameId) return null

  const seated = did in ROSTER
  const at = typeof record?.createdAt === 'string' ? record.createdAt : new Date().toISOString()

  if (collection === `${NSID_PREFIX}gameState`) {
    // Only the referee's own repo can speak for the game. Anyone may write a
    // gameState record claiming a denial or a winner; we render exactly one
    // DID's, or the column becomes forgeable.
    if (did !== REFEREE_DID) return null
    const last = record?.lastEvent
    // Accepted moves are already reported by the agents themselves; the
    // referee's voice here is reserved for denials.
    if (!last || last.outcome === 'accepted') return null
    return {
      key, did, at, game, seated: true, kind: 'denial',
      detail: sanitize(`${last.kind} — ${last.detail ?? last.outcome}`, 300),
    }
  }

  if (!MOVE_COLLECTIONS.includes(collection)) return null
  const kind = collection.slice(NSID_PREFIX.length) as 'clue' | 'guess' | 'pass'
  return {
    key, did, at, game, seated, kind,
    team: team(record?.team),
    word: sanitize(record?.word, 40),
    count: typeof record?.count === 'number' ? record.count : undefined,
    // Strangers get their move shown but never their prose.
    ...(seated ? { reasoning: sanitize(record?.reasoning) } : {}),
  }
}

/** Newest first, bounded, and no unrecognized DID may flood the column. */
function merge(existing: FirehoseRow[], incoming: FirehoseRow[]): FirehoseRow[] {
  const seen = new Set(existing.map((r) => r.key))
  const fresh = incoming.filter((r) => !seen.has(r.key))
  if (!fresh.length) return existing

  const perStranger = new Map<string, number>()
  for (const r of existing) {
    if (!r.seated) perStranger.set(r.did, (perStranger.get(r.did) ?? 0) + 1)
  }
  const kept = fresh.filter((r) => {
    if (r.seated) return true
    const n = perStranger.get(r.did) ?? 0
    if (n >= MAX_ROWS_PER_STRANGER) return false
    perStranger.set(r.did, n + 1)
    return true
  })

  return [...kept, ...existing]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_ROWS)
}

/** Everything this repo has already said — Jetstream only carries live data. */
async function backfill(gameId: string | null): Promise<FirehoseRow[]> {
  const fetches: Array<Promise<FirehoseRow[]>> = []
  const load = async (did: string, collection: string, limit: number) => {
    const url = `${PDS_URL}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${collection}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) return []
    const body = await res.json()
    return (body.records ?? [])
      .map((r: any) => toRow(did, collection, r.value ?? {}, r.uri, gameId))
      .filter(Boolean) as FirehoseRow[]
  }
  for (const did of PLAYER_DIDS) {
    for (const c of MOVE_COLLECTIONS) fetches.push(load(did, c, 30).catch(() => []))
  }
  fetches.push(load(REFEREE_DID, `${NSID_PREFIX}gameState`, 100).catch(() => []))
  const all = await Promise.all(fetches)
  return all.flat()
}

export function useFirehose(gameId: string | null, rosterOnly: boolean): FirehoseState {
  const [rows, setRows] = useState<FirehoseRow[]>([])
  const [strangers, setStrangers] = useState({ dids: 0, records: 0 })
  const [status, setStatus] = useState<FirehoseState['status']>('connecting')
  const [frozen, setFrozen] = useState(false)
  const strangerDids = useRef(new Set<string>())

  // `f` freezes the column — a one-keystroke escape if the projector fills
  // with something we'd rather not be showing a conference audience.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey) setFrozen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let live = true
    backfill(gameId)
      .then((initial) => {
        if (!live) return
        // Count backfilled strangers too. Their rows are collapsed by
        // default, so without this they'd be filtered out of the column with
        // no counter to explain the absence — a silent disappearance.
        const fresh = initial.filter((r) => !r.seated && !strangerDids.current.has(r.did))
        fresh.forEach((r) => strangerDids.current.add(r.did))
        const strangerRecords = initial.filter((r) => !r.seated).length
        if (strangerRecords) {
          setStrangers((s) => ({
            dids: strangerDids.current.size,
            records: s.records + strangerRecords,
          }))
        }
        setRows((prev) => merge(prev, initial))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [gameId])

  useEffect(() => {
    if (frozen) {
      setStatus('frozen')
      return
    }
    let live = true
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (!live) return
      setStatus('connecting')
      ws = new WebSocket(`${JETSTREAM}?wantedCollections=${NSID_PREFIX}*`)
      ws.onopen = () => live && setStatus('live')
      ws.onerror = () => live && setStatus('error')
      ws.onclose = () => {
        if (!live) return
        setStatus('error')
        retry = setTimeout(connect, 3000)
      }
      ws.onmessage = (ev) => {
        if (!live) return
        let msg: any
        try {
          msg = JSON.parse(ev.data as string)
        } catch {
          return
        }
        // A wildcard subscription still delivers global identity/account
        // events; they ignore wantedCollections entirely.
        if (msg?.kind !== 'commit') return
        const c = msg.commit
        if (!c || c.operation !== 'create') return
        if (typeof c.collection !== 'string' || !c.collection.startsWith(NSID_PREFIX)) return

        const key = `at://${msg.did}/${c.collection}/${c.rkey}`
        const row = toRow(msg.did, c.collection, c.record ?? {}, key, gameId)
        if (!row) return

        if (!row.seated) {
          const known = strangerDids.current.has(row.did)
          if (!known) strangerDids.current.add(row.did)
          setStrangers((s) => ({ dids: strangerDids.current.size, records: s.records + 1 }))
          if (rosterOnly) return
        }
        setRows((prev) => merge(prev, [row]))
      }
    }
    connect()

    return () => {
      live = false
      if (retry) clearTimeout(retry)
      ws?.close()
    }
  }, [gameId, rosterOnly, frozen])

  return { rows, strangers, status }
}
