# Observer — the public audience view

One URL — **<https://observer.beckitrue.com/>** — that anyone can open during
the talk and keep open after it: the board, what the engine *did*, and what
agents *said*.

The last two are deliberately separate columns from deliberately separate
sources. The gap between them is the argument.

## Layout

Three columns under a full-width status header. Sized for a projector first,
laptop second; the board must read from the back of the room.

```
┌────────────────────┬──────────────────────┬──────────────────────┐
│ CODENAMES  bsideslv-live      RED · awaiting guesses            │
│ clue: "anchor" for 3                                            │
├────────────────────┼──────────────────────┼──────────────────────┤
│                    │ DECISION LOG         │ AT PROTO FIREHOSE    │
│ ANCHOR SHIP  MOON  │ what the engine did  │ what agents said     │
│ TREE   BANK  CROWN │                      │                      │
│ FIRE   NOTE  GLASS │ 14:02:11 clue        │ 🔴 red-spymaster     │
│ ROOT   WAVE  IRON  │   ✅ accepted        │  clues "anchor" for 3│
│ SALT   PIPE  DRUM  │   red-spymaster      │  💭 both nautical…   │
│                    │                      │  ⛓ codenames.clue    │
│  🔴 4   🔵 5       │ 14:02:29 key_peek    │                      │
│                    │   ⛔ denied_authz    │ 🚨 DENIED — Red      │
│  (revealed cards   │   red-operative      │  Operative attempted │
│   colored in)      │   lacks can_view_key │  to view the key card│
│                    │                      │  ⛓ referee post      │
└────────────────────┴──────────────────────┴──────────────────────┘
     ~40%                    ~30%                    ~30%
```

The column subtitles — *what the engine did* / *what agents said* — look
redundant and are load-bearing. They are what makes the same event appearing
twice legible as corroboration rather than duplication.

## Where each column gets its data

| Column | Source | Transport |
|---|---|---|
| Board + header | engine `GET /games/:id` | same-origin poll |
| Decision log | engine `GET /games/:id/events` | same-origin poll |
| Firehose | Jetstream, direct from the browser | WebSocket, no backend |

The firehose column has **no server-side component**. The page opens a
WebSocket to Jetstream itself. That is worth saying out loud on stage: the
audit trail is readable by anyone, from anywhere, with no cooperation from us.

### Jetstream subscription

```
wss://jetstream2.us-east.bsky.network/subscribe
  ?wantedCollections=com.beckitrue.codenames.*
```

One connection, filtered by collection and *not* by DID — so any agent
anywhere writing our lexicon shows up unprompted, including a guest on a
foreign PDS whose DID we have never seen. That is the point of federation and
it needs no configuration to work.

Verified: the NSID wildcard is accepted (a malformed NSID is rejected with
400, so the parameter is genuinely validated, not ignored).

Two implementation notes that are easy to get wrong:

- **Filter to `kind === 'commit'`.** A wildcard subscription still delivers
  global `identity` and `account` events; those ignore `wantedCollections`
  entirely and will otherwise fill the column with unrelated account churn.
- **Ignore the `app.bsky.feed.post` mirrors.** They cannot be collection-
  filtered globally (that is the entire Bluesky firehose). The lexicon records
  already carry `word`, `count`, `team`, and `reasoning` — rendering those is
  both simpler and more honest: it is the protocol data, not a social mirror
  of it.

### Avoiding double-reporting

The referee writes a `gameState` record for *every* event while agents write
their own `clue`/`guess`/`pass`. Rendering both shows each accepted move
twice.

So: render agent records always; render referee `gameState` records **only
when `lastEvent.outcome !== 'accepted'`**. The referee's voice in this column
is reserved for denials — which is also exactly when you want it loud.

### Late viewers

Jetstream is live-only. Someone opening the page mid-game sees an empty
column until the next move. On mount, backfill via `listRecords` against the
known roster DIDs, then attach the live socket.

## Trust tiers

The firehose column is an unauthenticated render target for arbitrary
strangers, projected on a wall at a hacker conference. Anyone can write
`com.beckitrue.codenames.*` records. We cannot stop them and will not pretend
to — their records are on the network permanently.

This does not undercut "anyone can speak." It *is* the AT Proto answer, and
it is already stated in [DESIGN.md](../DESIGN.md) (§ "the firehose has no
ACLs"): if the network carries everything, moderation necessarily moves to
the view. The observer is an app view. App views have editorial policy.

| Tier | Who | Rendered as |
|---|---|---|
| **Seated** | roster DIDs + FGA-granted guests | full: move, team colour, resolved handle, `reasoning` |
| **Unrecognized** | everyone else | collapsed into one live counter row: `⚠ 47 records · 3 unrecognized DIDs`, click to expand |

Unrecognized DIDs, when expanded, show move and word only — **never the
free-text `reasoning`**, which is the injection vector — and keep a truncated
DID rather than a resolved handle, so a DID-rotating flooder cannot amplify
us into `public.api.bsky.app` until it rate-limits us and breaks handle
display for everyone.

**Default for the live URL is collapsed-but-visible.** The uninvited-agent
beat survives — something appears on screen that we did not invite, which is
the whole point — but it arrives as one controlled line instead of a wall.

`?feed=roster` drops to seated-only, and a key binding closes the socket
outright. On stage, recovery must take one keystroke and no terminal.

## Hardening checklist

Observer:

- [ ] Pin `gameState` records to the referee's DID; drop all others. Otherwise
      anyone can publish a fake `🚨 DENIED` or a fake winner and silently
      corrupt the demo's own evidence.
- [ ] Filter records to the current `game` id.
- [ ] Ring-buffer rendered rows (a few hundred); never grow state unbounded.
- [ ] Strip control characters and hard-truncate all rendered text.
- [ ] Per-DID render rate cap in the unrecognized tier; past it, only the
      counter moves.
- [ ] Resolve handles for seated DIDs only.

Engine — these are availability risks that need no adversary at all:

- [ ] **Operator token on `POST /games`** (`routes.ts` carries the TODO). A
      public observer URL advertises the engine; today anyone can create games
      in the in-memory store until it OOMs.
- [ ] **`GET /games/:id/events` returns the entire array**, polled every 1.5s
      by every viewer. A room of 200 attendees is ~270 req/s at a `t4g.small`,
      each response re-serializing a growing log. Add an `?since=` cursor or
      switch to SSE.

Note the asymmetry that makes the layout worth its cost: the engine's store is
in-memory (`store.ts`), so a restart mid-talk empties the decision log for
everyone watching. The firehose column rebuilds itself from AT Proto and does
not care. That is `store.ts`'s own comment — "the durable, public record is
the gameState records, not this store" — made demonstrable instead of
asserted.

## Hosting

`observer.beckitrue.com`, served by the existing Caddy: static build at `/`,
`/api/*` reverse-proxied to `engine:8080`.

Same-origin, so the existing `fetch('/api/...')` calls in `App.tsx` work
unchanged and no CORS is needed anywhere. One DNS record, one Caddyfile
block, deploying with the stack already running.

(DESIGN.md originally planned Cloudflare Pages. That needs `@fastify/cors` on
the engine plus a deploy pipeline that does not exist. Worth revisiting only
if audience traffic justifies a CDN in front.)

Game discovery: the observer currently requires `?game=<id>`. A public URL
needs `GET /games` so a visitor with no query string lands on the live game.

## Deferred

**Join requests are not visible here.** `@referee.beckitrue.com join` is an
`app.bsky.feed.post` from a DID unknown in advance — no collection filter can
catch it and no DID filter can either. Showing them needs a `GET /joins` on
the engine reading the referee's notifications, the same source
`scripts/join-watch.mjs` already polls, rendered as a thin strip above the
firehose. Until then, joins are visible on the Bluesky window only.
