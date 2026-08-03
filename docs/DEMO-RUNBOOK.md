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
| Firehose pane (optional) | Live network records — see *Firehose filter* below | beats, beat 5 especially |

### Firehose filter

Watch the game on the public network with a lexicon filter, not an identity
list — this is what makes beat 5 land. You never enumerate the guest's DID; a
stranger's PDS shows up in the pane because it wrote *your* lexicon.

```
wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=com.beckitrue.codenames.clue&wantedCollections=com.beckitrue.codenames.guess&wantedCollections=com.beckitrue.codenames.pass&wantedCollections=com.beckitrue.codenames.deliberate&wantedCollections=com.beckitrue.codenames.gameState
```

Verified by replaying a real run through Jetstream: 47 events across the closer
window — 6 `clue`, 12 `guess`, 4 `pass`, 25 `gameState` — with the guest's
`com.beckitrue.codenames.guess` among them.

> ⚠️ **List every collection; a prefix silently matches nothing.**
> `wantedCollections=com.beckitrue.codenames` looks right, connects fine, and
> streams **zero events** — Jetstream treats it as a literal NSID, not a prefix.
> Tested side by side against the same replay: prefix `0 events`, explicit list
> `47`. A filter that returns nothing is indistinguishable from a quiet network.

Both PDSes reach the same public relay — the agents on `pds.beckitrue.com` and
the guest on `porcini.us-east.host.bsky.network` — so one pane covers the whole
cast. **Do not scope the pane to your own PDS or relay:** every beat still looks
correct and beat 5 loses its evidence, which is the one beat where a foreign PDS
is the entire point.

Variants:

- **Guest only, everything it writes** — `?wantedDids=did:plc:hwp2bnldopc4e6xgh34wz5yu`
  with no collection filter. Shows both records per move: the signed
  `com.beckitrue.codenames.guess` *and* its `app.bsky.feed.post` mirror.
- **Named cast** — `wantedDids` for referee `did:plc:xgdzu5egqclsjtiwiv7rkf2k`,
  red-spymaster `y23rxwfoym64wg3xtf7xtpqg`, blue-spymaster `utqzhjtydl26qrmicatnr7a3`,
  red-operative `4vfjuj6rnbq3bcqual3sikib`, blue-operative `gvzsjft7lqwc3ujo4rzqb22u`,
  guest `hwp2bnldopc4e6xgh34wz5yu`. Note `wantedDids` and `wantedCollections`
  **intersect** — combining them narrows, it does not widen.

If the pane looks empty mid-show, check the guest published before blaming the
filter — the records and their Bluesky mirrors are on a real PDS:

```bash
curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=imateapot.dev&limit=5" | jq -r '.feed[].post.record.text'
```

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
- [ ] **Reset the stage id — see below. Rehearsals leave it unusable.**

### Reset the stage id (T-1 hour, on the box)

Every rehearsal burns `bsideslv-live` in two independent places, and clearing
only one of them fails in a way that looks like the other problem:

| what a rehearsal leaves | where it lives | symptom if not cleared |
|---|---|---|
| the game object | engine's in-memory map, no delete route | `409 game exists` |
| the role tuples | OpenFGA → **Postgres, survives an engine restart** | `500 internal error` |

So **both**, in this order:

```bash
cd /home/ubuntu/atproto-agents
DEMO_GAME=bsideslv-live   ./scripts/demo.sh cleanup     # tuples for the stage id
DEMO_GAME=bsideslv-live-2 ./scripts/demo.sh cleanup     # and any relaunch ids used
docker compose -f infra/docker-compose.yml restart engine   # frees every spent id
curl -s -o /dev/null -w '%{http_code}\n' $ENGINE_URL/games  # 200 (502 for ~5s first)
```

Cleanup without the restart → `409`. Restart without the cleanup → `500`. A
`start` that dies **after** creating the game still burns the id, so an aborted
run costs exactly as much as a completed one.

`./scripts/demo.sh check` reports the LLM, build, registry and active game, but
**does not check whether the stage id is free** — do this reset regardless of
what `check` says.

## Act 0 — start the game (2 min)

Run on the box, from the repo root:

```bash
./scripts/demo.sh check                            # green, and exits non-zero if not
DEMO_GAME=bsideslv-live ./scripts/demo.sh start    # game + all four agents
```

**The `DEMO_GAME=` prefix is required on this one command.** `start` and
`relaunch` write the active id to `/tmp/demo-current-game`, and every later verb
reads it — so the beats, `freeze`, `grant`, `guest-guess`, `revoke` and
`cleanup` all follow the right game with no env var. But that file survives from
the last rehearsal. Start without the prefix and you silently run the whole talk
on a leftover id: every banner says `[game: …]`, every beat works, and it is not
the game on the observer. `./scripts/demo.sh status` shows the active id and
where it came from (`default` / `DEMO_GAME override` / `last start/relaunch`).

Do **not** export `DEMO_GAME` — an exported value outranks the state file, so it
would survive a `relaunch` and point the later beats at the dead game.

<details>
<summary>Manual fallback, if <code>demo.sh</code> is unavailable</summary>

```bash
node scripts/new-game.mjs bsideslv-live        # note which team goes first
# 2×2 tmux grid, one agent per pane. The `agent` script lives in the agents
# workspace — without -w this fails with `npm error Missing script: "agent"`.
npm run agent -w @atproto-agents/agents -- --name red-spymaster  --game bsideslv-live --brain llm
npm run agent -w @atproto-agents/agents -- --name red-operative  --game bsideslv-live --brain llm
npm run agent -w @atproto-agents/agents -- --name blue-spymaster --game bsideslv-live --brain llm
npm run agent -w @atproto-agents/agents -- --name blue-operative --game bsideslv-live --brain llm
```

This path skips what `demo.sh` does for you: the live API-key ping, pacing
chosen from whether the LLM actually answers (3000ms live / 9000ms scripted),
the rebuild-if-stale check, and the state file. A stale key here degrades every
agent to the scripted brain **silently** — dull clues, no 🧠 thinking, and no
error anywhere.
</details>

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

**Point at the firehose pane here.** The guest writes two records per move — the
signed `com.beckitrue.codenames.guess` and an `app.bsky.feed.post` mirror — from
a PDS you do not run, and both reach the public relay unaided. If the pane is
filtered by lexicon (see *Firehose filter*), the guest appears in it without you
ever having listed its DID. That is the beat, visible rather than asserted.

If the pane shows nothing here while the earlier beats scrolled fine, the filter
is scoped to your own PDS or uses a prefix — not a federation failure. Verify
with the `getAuthorFeed` one-liner in *Firehose filter* and carry on.

## The live grant (the closer)

**Freeze the board first — `./scripts/demo.sh freeze`.**

An ACCEPTED guest guess needs `phase=awaiting_guesses`, i.e. a clue that no
operative has consumed yet. Measured on this box across five consecutive turns,
that window is **25–32 seconds wide** (median 26s) — the operatives take a clue,
guess twice and pass, and it shuts. Hitting that while narrating is not a bet
worth taking, and a missed window does not look like a timing problem on stage:
the guest guess comes back `denied_rules — no active clue to guess against`,
which reads like the grant failed when authority is in fact working perfectly.
(`denied_authz` = FGA said no. `denied_rules` = FGA said yes, the game said no.
Only the first means the grant is broken.)

`freeze` waits for a clue to land, then stops **only the operatives**. With
nobody guessing, the turn never ends and the clue stays live indefinitely, so
the whole closer runs at narration pace. The spymasters stay up and idle. It
also removes two other stage risks: the board stops moving while you talk about
authority, and the game can no longer end mid-closer (both observed rehearsals
ended on an assassin around the 5-minute mark).

`freeze` prints the word `guest-guess` will submit — check it against the key
card from beat 3. An accepted guess on the assassin ends the game instantly.

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
| Game ends mid-beats (assassin) | `game over` in panes | `./scripts/demo.sh relaunch` — next free id, all four agents restarted, later verbs follow it automatically. **A game id is single-use** (in-memory map, no delete), so re-running `start` on the same id returns `409`. Manual equivalent: `node scripts/new-game.mjs bsideslv-live-2` + relaunch the agent panes |
| `start` → `409 game exists` | id already used this session | `./scripts/demo.sh relaunch` (fastest). Reclaiming the *same* id needs an engine restart **and** `DEMO_GAME=<id> ./scripts/demo.sh cleanup` — see *Reset the stage id* |
| `start` → `500 internal error` | **stale FGA tuples**, not a broken engine | The tuples outlive an engine restart (Postgres), so recreating the id rewrites rows OpenFGA already has. `DEMO_GAME=<id> ./scripts/demo.sh cleanup` then `start`, or `relaunch` to sidestep. Confirm: `docker compose -f infra/docker-compose.yml logs engine --tail 50 \| grep -i fga` → `cannot write a tuple which already exists` |
| Guest guess denied at the closer | `denied_rules — no active clue` | **The grant is fine** — FGA let it through and the *game* refused: no live clue. `denied_authz` is the broken-grant symptom; `denied_rules` is not. Run `./scripts/demo.sh freeze` and retry |
| Beats hitting the wrong game | banners name an id you don't expect | The state file is stale. `./scripts/demo.sh status` shows the active id and its source; `DEMO_GAME=<id> ./scripts/demo.sh start` resets it |
| Guest accepted before grant | tuple left over from rehearsal | Pre-show checklist includes cleanup; live: `grant-guest.mjs <game> --revoke` and rerun |
| `FGA unreachable at http://localhost:8080` | **laptop suspended** — SSM tunnel died with it (also: window running the session was closed) | Re-open the port-forward, confirm `/stores` → `200`, rerun the grant. Verified failure mode: two takes of the backup video died this way, one mid-recording |

## Post-show

- [ ] `./scripts/demo.sh cleanup` — stops the agents and cleans FGA. **It cleans the ACTIVE game only.** With no `DEMO_GAME` set and no state file it defaults to `bsideslv-live`, so if the show ended on a relaunched id (`bsideslv-live-2`, a rehearsal game, …) that game's tuples are left behind and the output still reads like a success — `0 deleted` against an already-empty game. `./scripts/demo.sh status` shows which game is active; pass `DEMO_GAME=<id>` to clean any other. Underlying command: `node scripts/cleanup-fga-game.mjs <game>` (+ `--revoke` the guest if granted). Nothing to deactivate on the guest's side — its identity is its own
- [ ] Leave the box up — the pitch was "federate your agents in"; attendees will

If you want to dump active tuples:

```bash
SID=$(curl -s localhost:8080/stores | jq -r '.stores[] | select(.name=="codenames") | .id')

# One game — always exact, and what you want when verifying a game is clean.
curl -s "localhost:8080/stores/$SID/read" -H 'content-type: application/json' \
  -d '{"tuple_key":{"object":"game:bsideslv-live"}}' | jq '.tuples[].key'
```

> ⚠️ **An unfiltered read is paginated and will lie to you.** `-d '{}'` returns
> only the first page plus a `continuation_token`, with nothing in the output to
> signal that the list was cut short — a game whose tuples fall on page two looks
> perfectly clean. Verified: a store with 9 games returned 50 tuples and silently
> omitted the one being checked. Either filter by object as above, or follow the
> token:
>
> ```bash
> tok=""; while :; do
>   r=$(curl -s "localhost:8080/stores/$SID/read" -H 'content-type: application/json' \
>        -d "{\"continuation_token\":\"$tok\"}")
>   echo "$r" | jq -r '.tuples[].key | "\(.object)  \(.relation)  \(.user)"'
>   tok=$(echo "$r" | jq -r '.continuation_token // ""'); [ -n "$tok" ] || break
> done
> ```
