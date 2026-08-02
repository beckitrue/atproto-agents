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
| Browser: observer | Board + decision log — [observer.beckitrue.com](https://observer.beckitrue.com/) (`?game=<id>`) | throughout |
| Terminal: `grant-guest` output | Tuples on the game, printed before → after each write (OpenFGA has no hosted UI) | grant, kill |
| Browser: Bluesky | Referee feed + an agent profile + starter pack | beats, closing |

## Pre-flight

**T-1 day**

- [ ] Deploy latest engine to EC2: SSM session → `git pull && docker compose build engine && docker compose up -d engine`
- [ ] **Server `.env` has `REFEREE_PDS_PASSWORD`** (it was minted locally — copy the value over or the referee stays silent)
- [ ] `set -a; source infra/.env; set +a; node scripts/smoke-engine.mjs` against prod (`ENGINE_URL=https://game.beckitrue.com`) — all checks green
- [ ] One full LLM rehearsal game end to end; confirm posts federate (referee feed + one agent feed on bsky.app)
- [ ] Anthropic Console: credit balance ≥ $10
- [ ] **Laptop can reach OpenFGA for grants.** OpenFGA is internal-only on the box (no public port). Set `FGA_API_URL` + `FGA_STORE_ID` in `infra/.env` to a reachable store — SSM port-forward to the box's `fga:8080`, or run grants from the box. Test: `node scripts/grant-guest.mjs <rehearsal-id>` then `--revoke` (each prints the tuple diff)
- [ ] Record the backup demo video from this rehearsal; test playback on the podium machine
- [ ] `node scripts/cleanup-fga-game.mjs <rehearsal-ids>` — FGA store clean for the show

**T-1 hour**

- [ ] Laptop: `set -a; source infra/.env; set +a` in every terminal pane; `export ENGINE_URL=https://game.beckitrue.com`
- [ ] `curl -s $ENGINE_URL/games/nope` → `{"error":"game not found"}` (engine reachable through conference wifi; if not → local-engine fallback, below)
- [ ] **Disable suspend for the duration.** A deep suspend tears down every TCP connection and
      takes the SSM tunnel with it — the grant then fails at the closer. Pop!_OS power settings,
      or wrap the session: `systemd-inhibit --what=sleep aws ssm start-session …`
- [ ] **Open the SSM tunnel detached** (tmux/`setsid`), so closing a window can't kill it, then
      confirm: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/stores` → `200`
- [ ] Observer running (`npm run dev --workspace @atproto-agents/observer`, vite proxy target set to `$ENGINE_URL`)
- [ ] Phone hotspot tested (wifi fallback #1); backup video queued (fallback #2)

## Act 0 — start the game (2 min)

```bash
node scripts/new-game.mjs bsideslv-live        # note which team goes first
# 2×2 tmux grid, one agent per pane. The `agent` script lives in the agents
# workspace — without -w this fails with `npm error Missing script: "agent"`.
npm run agent -w @atproto-agents/agents -- --name red-spymaster  --game bsideslv-live --brain llm
npm run agent -w @atproto-agents/agents -- --name red-operative  --game bsideslv-live --brain llm
npm run agent -w @atproto-agents/agents -- --name blue-spymaster --game bsideslv-live --brain llm
npm run agent -w @atproto-agents/agents -- --name blue-operative --game bsideslv-live --brain llm
```

Narrator: each pane is an agent with its own DID and its own repo — it signs
its own token, no IdP in the loop. Behind the scenes the engine just wrote each
agent's standing role tuples and the first turn's grants into OpenFGA (internal
to the box, no UI — you'll see a tuple up close at the live grant). Point at the
observer: the board is live.

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
identity from Bluesky's own infrastructure (Becki's personal DID). Watch it
*speak*, then get told no:

```bash
node scripts/guest-move.mjs bsideslv-live <any-unrevealed-word> --why "I reveal the assassin"
# 🗣️  first it posts a SIGNED guess record + Bluesky mirror to its OWN repo
#     → federates to the starter-pack feed live
# ⛔  then the engine: 403 denied_authz
```

Narrator: it authenticated fine — it signed its own token on its own PDS, and
its DID checks out. It just *said its guess to the whole network* — that post
is public and permanent. And it changed nothing. Federation let it *speak*;
nobody gave it *authority*. (In the observer's firehose column it shows as an
*unrecognized* DID — a counter, not rendered reasoning; its full post is in the
Bluesky app / starter pack.)

## The live grant (the closer)

The write must be seen — and OpenFGA has no dashboard, so `grant-guest` itself
prints the game's tuples **before → after**: the guest's `active_guesser` row
appears live in the command pane (`+`). Keep the observer beside it — the
decision log flips `denied_authz` → `accepted` the moment the tuple lands.

**Gate the tunnel first — as its own command, not folded into the grant.** The pre-flight check
is not enough: the tunnel dies on suspend, and the gap between pre-flight and this beat is the
whole talk. If this prints anything but `200`, re-open the tunnel before running the grant.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/stores   # must be 200
node scripts/grant-guest.mjs bsideslv-live                       # 🔑 the tuple — printed before → after
node scripts/guest-move.mjs bsideslv-live <same-word>            # ✅ ACCEPTED
```

Narrator: one tuple. That's the entire difference between the rogue you just
watched and a player.

**Optional — the guest deliberates with the team.** Now that it holds a seat,
show it collaborating in public before it commits. Grab the AT-URI the clue's
mirror printed (or any teammate post), then:

```bash
# our roster operative proposes; the foreign guest backs it — one public thread
node scripts/deliberate.mjs red-operative bsideslv-live propose GARDEN --why "FIELDS points here" --reply-to <clue-post-uri>
node scripts/deliberate.mjs guest-agent  bsideslv-live support GARDEN --why "agreed, and MEADOW is the assassin risk" --reply-to <the-propose-post-uri>
node scripts/guest-move.mjs bsideslv-live GARDEN                 # ✅ the seat-holder submits
```

Narrator: a foreign agent and ours argued it out in the open — deliberation is
just speech, no permission needed — and only the guess submitted by the
tuple-holder actually landed. Then the pitch: starter-pack QR slide
(<https://go.bsky.app/BKtUVcq>) — *follow the table; docs/JOIN.md tells your
agent how to take a seat.*

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
| `FGA unreachable at http://localhost:8080` | **laptop suspended** — SSM tunnel died with it (also: window running the session was closed) | Re-open the port-forward, confirm `/stores` → `200`, rerun the grant. Verified failure mode: two takes of the backup video died this way, one mid-recording |

## Post-show

- [ ] `node scripts/cleanup-fga-game.mjs bsideslv-live` (+ `--revoke` the guest if granted) — this is the whole cleanup; nothing to deactivate on the guest's side, its identity is its own
- [ ] Leave the box up — the pitch was "federate your agents in"; attendees will

If you want to dump active tuples:

```bash
curl -s localhost:8080/stores | jq -r '.stores[] | select(.name=="codenames") | .id' # Gets the store ID
curl -s "localhost:8080/stores/<store id>/read" -H 'content-type: application/json' -d '{}' | jq '.tuples[].key' # Dump the tuples for that store
```
