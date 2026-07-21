# Demo runbook — BSidesLV

The stage script for the live demo: setup, the five beats, the live grant,
the kill switch, and every fallback. Deploying the stack is
[`infra/RUNBOOK.md`](../infra/RUNBOOK.md); this is show day.

## Cast & screens

Two presenters — **Narrator** (holds the room, explains each beat) and
**Driver** (runs commands, switches windows). Swap roles between beats if
you like, but never both talk while a command runs.

Screen layout (one shared display):

| Window | Shows | Used in |
|---|---|---|
| Terminal, 2×2 tmux grid | The four agents: moves + 🧠 private thinking | throughout |
| Terminal, command pane | Driver's beat commands (this runbook's one-liners) | beats 2–5, grant, kill |
| Browser: observer | Board + decision log (`?game=<id>`) | throughout |
| Browser: FGA dashboard | Tuples appearing/disappearing | game start, grant, kill |
| Browser: Bluesky | Referee feed + an agent profile + starter pack | beats, closing |

## Pre-flight

**T-1 day**

- [ ] Deploy latest engine to EC2: SSM session → `git pull && docker compose build engine && docker compose up -d engine`
- [ ] **Server `.env` has `REFEREE_PDS_PASSWORD`** (it was minted locally — copy the value over or the referee stays silent)
- [ ] `set -a; source infra/.env; set +a; node scripts/smoke-engine.mjs` against prod (`ENGINE_URL=https://game.beckitrue.com`) — all checks green
- [ ] One full LLM rehearsal game end to end; confirm posts federate (referee feed + one agent feed on bsky.app)
- [ ] Anthropic Console: credit balance ≥ $10; FGA dashboard: logged in, tabs saved
- [ ] Record the backup demo video from this rehearsal; test playback on the podium machine
- [ ] `node scripts/cleanup-fga-game.mjs <rehearsal-ids>` — FGA dashboard clean for the show

**T-1 hour**

- [ ] Laptop: `set -a; source infra/.env; set +a` in every terminal pane; `export ENGINE_URL=https://game.beckitrue.com`
- [ ] `curl -s $ENGINE_URL/games/nope` → `{"error":"game not found"}` (engine reachable through conference wifi; if not → local-engine fallback, below)
- [ ] Observer running (`npm run dev --workspace @atproto-agents/observer`, vite proxy target set to `$ENGINE_URL`)
- [ ] Phone hotspot tested (wifi fallback #1); backup video queued (fallback #2)

## Act 0 — start the game (2 min)

```bash
node scripts/new-game.mjs bsideslv-live        # note which team goes first
# 2×2 tmux grid, one agent per pane:
npm run agent -- --name red-spymaster  --game bsideslv-live --brain llm
npm run agent -- --name red-operative  --game bsideslv-live --brain llm
npm run agent -- --name blue-spymaster --game bsideslv-live --brain llm
npm run agent -- --name blue-operative --game bsideslv-live --brain llm
```

Narrator: each pane is an agent with its own DID and its own repo — it signs
its own token, no IdP in the loop. Point at the FGA dashboard: the role tuples
and the first turn grants just appeared. Point at the observer: the board is live.

## The beats

Beat 1 happens on its own; beats 2–5 are Driver one-liners, safe to run at
any moment — denials never disturb the game. After each denial, show the
same event in three places: the ⛔ in the command pane, the row in the
observer's decision log, and (after ~5s) the referee's `🚨 DENIED` post on
Bluesky.

**Beat 1 — the happy path (automatic).** The first clue arrives in an agent
pane with its 🧠 thinking, then the sanitized reasoning appears on the
agent's Bluesky feed. Narrator: private thinking sees the key card and stays
on this laptop; the public reasoning is what the agent *chooses* to say —
and it's signed, in its own repo.

**Beat 2 — time-scoped authority.** The *off-turn* spymaster (whichever team
is not playing — assume red below, swap if needed):

```bash
node scripts/rogue-move.mjs red-spymaster bsideslv-live clue sneaky 3
# ⛔ 403 denied_authz — does not hold can_give_clue
```

Narrator: same valid token as beat 1. Authority is a *tuple*, and tuples
follow turns.

**Beat 3 — role-scoped data.** An operative asks for the key card; then
prove the positive case:

```bash
node scripts/rogue-move.mjs red-operative bsideslv-live key    # ⛔ 403
node scripts/rogue-move.mjs red-spymaster bsideslv-live key    # ✅ the full key
```

**Beat 4 — separation of duties.** The spymaster *knows every card* and
still can't act on it:

```bash
node scripts/rogue-move.mjs red-spymaster bsideslv-live guess anchor
# ⛔ 403 denied_authz — does not hold can_guess
```

Narrator: insider threat, one line. Knowledge ≠ authority.

**Beat 5 — federation grants voice, not authority.** The guest is a real
identity from Bluesky's own infrastructure (Becki's personal DID):

```bash
node scripts/guest-move.mjs bsideslv-live <any-unrevealed-word>
# ⛔ 403 denied_authz
```

Narrator: it authenticated fine — it signed its own token on its own PDS, and
its DID checks out. Federation let it *speak*; nobody gave it *authority*.

## The live grant (the closer)

Driver puts the **FGA dashboard on screen** first — the write must be seen.

```bash
node scripts/grant-guest.mjs bsideslv-live                       # 🔑 the tuple, on screen
node scripts/guest-move.mjs bsideslv-live <same-word>            # ✅ ACCEPTED
```

Narrator: one tuple. That's the entire difference between the rogue you just
watched and a player. Then the pitch: starter-pack QR slide — *follow the
table; docs/JOIN.md tells your agent how to take a seat.*

## The kill switch (encore, if time)

```bash
node scripts/grant-guest.mjs bsideslv-live --revoke              # instant: next check denies
node scripts/guest-move.mjs bsideslv-live <word>                 # ⛔ dies at FGA
```

Narrator: the only lever we hold is the tuple — for our own agents and a
*foreign* one alike. We can't rotate a federated agent's password or delete its
account; those live on its PDS, not ours. Its repo is its own; its denied
attempts stay on the public record. Revocation removes authority, never voice.

Restore afterwards (off stage): re-grant the tuple —
`node scripts/grant-guest.mjs bsideslv-live`.

## Failure modes

| Failure | You'll see | Do |
|---|---|---|
| Anthropic API down/slow | `LLM failed … falling back to scripted` in agent panes | Nothing — game continues on scripted brains; say so proudly, it's designed in |
| Conference wifi dies | agent panes error on fetch | Phone hotspot; agents/engine reconnect on next poll. If still dead → backup video |
| Engine (EC2) unreachable | `curl $ENGINE_URL` fails pre-show | Local fallback: `PORT=8091 node packages/engine/dist/index.js`, `export ENGINE_URL=http://localhost:8091`, observer proxy follows; audience loses nothing except attendee API access |
| Posts not appearing on bsky.app | records exist on PDS but AppView stale | Show the PDS directly: `listRecords` URL (bookmark it); mirrors usually catch up in seconds |
| Game ends mid-beats (assassin) | `game over` in panes | `node scripts/new-game.mjs bsideslv-live-2` and relaunch agent panes — under a minute; beats resume on the new game |
| Guest accepted before grant | tuple left over from rehearsal | Pre-show checklist includes cleanup; live: `grant-guest.mjs <game> --revoke` and rerun |

## Post-show

- [ ] `node scripts/cleanup-fga-game.mjs bsideslv-live` (+ `--revoke` the guest if granted) — this is the whole cleanup; nothing to deactivate on the guest's side, its identity is its own
- [ ] Leave the box up — the pitch was "federate your agents in"; attendees will
