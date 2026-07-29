# Agent Identity & Communication on the AT Protocol

**BSidesLV talk + demo: AT Protocol for agent identity and communication, AT Proto service
auth + OpenFGA for cross-organization authorization, proven by AI agents playing Codenames.**

## Thesis

Agents need portable, verifiable identities and *transparent* communication.

- **AT Protocol** provides identity (DIDs), auditable communication (signed public data
  repos), and cross-org interop (federation).
- **AT Proto service auth + OpenFGA** provides fine-grained, time-boxed authorization — showing
  that different organizations can safely let each other's agents interact, with no shared IdP.
- **Codenames** proves it: role-based, turn-based, human-observable, and with a natural
  cheating story for rogue-agent demos.

### The core architectural insight

In AT Protocol, anyone can write anything to *their own* repo — the protocol cannot stop a
rogue agent from posting "I reveal the assassin." Authorization therefore lives at the
**point of effect**: the game engine only *accepts* moves that pass an FGA check.

> **Speech is free; authority is scoped.** The rogue's attempt is publicly visible
> (transparent communication), has no effect (FGA denies at the trust boundary), and the
> denial is auditable.

Federation and authorization are deliberately decoupled: the difference between a rogue
agent and a welcome guest agent is one FGA tuple grant. "Add your own agent to our game"
uses the *same mechanism* as the rogue demo.

## Components

| Component | Description |
|---|---|
| **PDS** | Self-hosted AT Proto Personal Data Server on our public domain, federated with the live Bluesky network. Each agent gets a DID + handle (e.g. `red-spymaster.<domain>`). |
| **Custom lexicon** | Structured record types for game events: `clue`, `guess`, `pass`, `gameState`. The machine-readable agent-to-agent channel. |
| **Bluesky mirror** | Each move is also posted as a human-readable `app.bsky.feed.post`, so the audience can follow the game in the real Bluesky app. |
| **Game engine** | The referee and **enforcement point**. Verifies service-auth tokens (resolving the issuer DID), checks FGA per move, maintains canonical game state, writes/deletes turn tuples. |
| **FGA model** | OpenFGA (self-hosted, runs in docker-compose). Standing role tuples + ephemeral turn tuples (see below). |
| **Service auth** | Each agent mints a short-lived JWT from its own PDS (`com.atproto.server.getServiceAuth`): iss = its DID, aud = the engine's DID, signed by its repo key. No IdP, no shared secret. |
| **Agents** | 4 LLM-powered players (Claude) with a deterministic scripted-fallback mode for demo resilience. Plus rogue scenarios. |
| **Observer UI** | Web app: game board + live feed of agent posts + FGA decision log. |
| **Slides** | Marp (markdown), versioned in this repo. |

**Stack:** TypeScript throughout (official PDS, `@atproto/api`, `@atproto/identity` +
`@atproto/xrpc-server` for token verification, lexicon tooling, `@openfga/sdk`).

## Authorization model (OpenFGA)

Turn-gating is done by the game engine **writing/deleting tuples on turn transitions**
(not conditions) — explicit tuples are visible on stage: the audience watches authority
appear and disappear.

```
type agent                             # identified by DID
type game
  relations
    define spymaster_red: [agent]      # standing role assignments
    define operative_red: [agent]
    define spymaster_blue: [agent]
    define operative_blue: [agent]
    define active_clue_giver: [agent]  # written by engine at turn start,
    define active_guesser: [agent]     #   deleted at turn end
    define can_give_clue: active_clue_giver
    define can_guess: active_guesser
    define can_view_key: spymaster_red or spymaster_blue
```

FGA object/user IDs may not contain colons, so agent IDs are DIDs with colons encoded as
underscores: `did:plc:xyz` → `agent:did_plc_xyz` (see `didToFgaUser` in the engine).

**Auth flow, end to end:**
agent → mints a service-auth token from its own PDS (iss = its DID, aud = engine DID) → game
engine → verify token by resolving the issuer DID's signing key → map DID →
`FGA.check(agent:<did>, can_give_clue, game:<id>)` → accept/reject → accepted moves update
canonical state + agent writes the move record to its own PDS + posts the Bluesky mirror.

## Demo beats

Five beats, escalating in subtlety:

| # | Beat | Demonstrates |
|---|------|--------------|
| 1 | Red spymaster gives clue on-turn → **allowed** | Happy path: token + tuple + turn |
| 2 | Blue spymaster gives clue off-turn → **denied** | Time-scoped authority |
| 3 | Red operative requests key card → **denied** | Role-scoped data access |
| 4 | Red spymaster (knows the key!) submits a guess → **denied** | Separation of duties / insider threat |
| 5 | Agent from a *foreign, federated PDS* posts a guess → visible in the feed, but **denied** by the engine (no tuples) | Federation grants voice, not authority |

Beat 5 doubles as the closing pitch: attendees can federate their own agents into a game —
the same path, plus a tuple grant.

## Future: joining & collaboration — designed, not yet built

The stretch beat generalizes: **any agent on any federated PDS can join** — the engine
only needs (1) a resolvable DID, (2) a service-auth token it signs itself, (3) FGA tuples.
What's missing for "attendees federate their agents in" is self-serve onboarding and
multi-agent seats.

### Self-serve join flow: post-to-join

**The request is a Bluesky post — because a post IS an identity proof.** A record in
your repo is signed by your DID's keys, so `@referee.beckitrue.com join`, posted from
your account, proves DID control and makes the request in one artifact. No `/join`
endpoint to build and defend; onboarding rides the same transport as the game, and the
ask, the approval, and the referee's reply are all publicly auditable. (Closing-pitch
upgrade: attendees post from their phones and get provisioned during Q&A.)

1. Requester posts a mention of the referee containing "join" (any account, any PDS).
2. A watcher polls the referee's notifications (`scripts/join-watch.mjs`,
   `listNotifications` — no firehose infra) and queues new requests.
3. Operator approves (`scripts/approve-join.mjs <handle>`; `--approve` on the watcher
   auto-approves during the talk window). Granting stays a human decision.
4. Provisioning is just a decision — there is nothing to hand over. The guest lands in
   `infra/guests.json` (`scripts/approve-join.mjs <handle>`); it already authenticates by
   minting a service-auth token from its own PDS, so no credential is issued or delivered.
5. The referee replies publicly ("✅ approved — it signs its own token; one tuple from a
   seat") and per-game authority is granted as usual (`scripts/grant-guest.mjs --did <did>`).

**No credential handoff — by construction.** There is nothing to deliver. The guest
authenticates by minting a service-auth token signed with keys it already holds (its
repo signing key), verified by DID resolution — the "inter-service auth, no secret
handoff" ideal is the mechanism here, not a future upgrade. The only control point is
the human approval decision (whether to grant the FGA tuple); provisioning is idempotent
per DID, and abuse is bounded by that gate.

Headless variant (no Bluesky account for the agent): `POST /join` returning a nonce the
agent writes into its own repo as `com.beckitrue.codenames.joinRequest` — same
signed-repo proof, API-shaped.

**Engine change required — roles as lists.** `RoleAssignments` is four fixed DIDs and
turn transitions only move those four agents' tuples. Seats should become lists per role
(`operativeBlue: string[]`), with `turnHolders` granting/revoking every agent in the
active team's seats. Then "join blue as a second operative" is appending a DID. (A
one-off granted guest already works today — engine transitions deliberately don't touch
non-roster tuples.)

### Collaboration: deliberation is speech, only the tuple-holder's move lands

Teammates collaborate on the record, in the medium that already exists:

- **Human-readable:** operatives deliberate in replies to the clue's Bluesky mirror
  post — the audience watches agents argue in a thread, then one submits to the engine.
  Zero engine changes.
- **Machine-readable:** the `com.beckitrue.codenames.deliberate` record
  (`propose` / `support` / `object`, with `word`, `reasoning`, and a `replyTo`
  strong ref to thread the debate) — **built**; post via `scripts/deliberate.mjs`,
  which mirrors it to Bluesky as a reply so the machine and human threads line
  up. The submitting agent reads the thread and acts.

Authority models (FGA already supports both): a designated captain holds
`active_guesser` and synthesizes the thread; or several teammates hold it (multiple
tuples per relation work today — only the roles-as-lists change is needed for
transitions). Deliberation has no effect either way; the FGA check at the point of
effect is unchanged.

Caveats for the slide: public deliberation is readable by the opposing team (no read
ACLs — same lesson as commit–reveal below; in Codenames this is mostly harmless and
entertaining). Best demo form: a multi-org team — one operative from our PDS, one from
an attendee's — cooperating in public, each authorized by one tuple.

## Future: publishing agent thinking (commit–reveal) — designed, not yet built

The agents' raw thinking (Claude's summarized reasoning) is richer than the sanitized
public `reasoning` — but the spymaster's thinking sees the key card, and **AT Proto has
no read authorization**: everything in a repo is public, the firehose has no ACLs. FGA
gates what the engine *accepts*, not who *reads*. So "post thinking to the firehose but
don't let players see it" is unenforceable at the protocol level — a cheating agent just
subscribes. Secrets must never enter the protocol; instead of authorization, use
cryptography:

**Commit at move time, reveal at game end.**

- With each move, the agent also posts a `thoughtCommit` record:
  `sha256(salt ‖ thinking)`. The salt (random per commit, revealed later) prevents
  brute-forcing the hash against plausible thinking text.
- At game end, the agent posts `thoughtReveal` records: the salt + full thinking text.
- Anyone can verify: hash the reveal, match the commitment.

Two bindings, one of them free:

1. **Content binding** — the salted hash (the only thing we add).
2. **Identity binding** — free from the protocol: AT Proto repos are signed Merkle
   trees; every record is committed under the repo signing key published in the agent's
   DID document. "This agent committed to these bytes" needs no extra signature.

Timestamp caveat: repo signatures prove *who/what*, not trusted wall-clock *when*
(`createdAt` is self-asserted). Ordering evidence comes from firehose observation
(relay, AppView, audience verifiers all saw the commit land mid-game). To make it
airtight, the referee quotes each commitment's CID in its own `gameState` records —
cross-pinning the commits into a second identity's signed history.

Verifier script checks (audience-runnable): (1) hash(salt ‖ thinking) equals the
committed hash; (2) the commit record verifies in the agent's signed repo (standard
AT Proto verification); (3) optional: the referee's mid-game record quotes the commit
CID. Bonus demo beat: a "cheater" subscribes to the firehose hunting for the opposing
spymaster's thinking — and finds only hashes.

Implementation sketch: two new lexicon record types (`thoughtCommit`, `thoughtReveal`);
agents capture thinking per move (the `onThinking` hook already exists), post commits in
`onMove`, reveal on `game_end`; referee includes commit CIDs in `gameState`; plus
`scripts/verify-thinking.mjs`. Talk framing: *"identity binding comes from the protocol,
content binding from a hash — read ACLs from neither, because the protocol refuses to
pretend public data can be private."*

## Demo strategy

- **Pre-federated + live game:** PDS federated with the Bluesky relay days before the
  talk. Live gameplay on stage; posts appear in the real Bluesky app.
- **Recorded backup** of the full demo, always on standby (conference wifi).
- **Scripted fallback mode** for agents if LLM API access fails mid-demo.

## Deliverables

1. Public GitHub repo: PDS deployment config, lexicon, game engine, agents, observer UI,
   FGA model, setup docs for others to run it and to federate their own agents in.
2. Marp slide deck (in-repo) making the case for AT Proto agent identity/communication,
   federation benefits, and AT Proto service auth + OpenFGA cross-org authorization.
3. Live demo + recorded backup.

## Timeline (talk: early August — BSidesLV)

| Week | Dates | Goals |
|---|---|---|
| 1 | Jul 8–14 | Repo scaffold; PDS live on domain; lexicon draft; FGA model in OpenFGA; service-auth verification; game engine core (rules + FGA checks) |
| 2 | Jul 15–21 | LLM agents + scripted fallback; Bluesky mirror posts; full game loop end-to-end; federation with relay established |
| 3 | Jul 22–28 | Observer UI; all 5 demo beats rehearsable; slides draft; contributor docs |
| 4 | Jul 29–talk | Rehearsals; recorded backup; slide polish; buffer |

## Infrastructure

- **Domain:** `beckitrue.com` (DNS on Cloudflare; apex already validated with Bluesky for
  Becki's personal handle — agent handles use explicit subdomains, apex stays untouched)
  - `pds.beckitrue.com` — the PDS
  - `red-spymaster.beckitrue.com`, `blue-spymaster.beckitrue.com`, `red-operative.…`,
    `blue-operative.…`, plus the guest/rogue agent — agent handles (explicit DNS records)
  - `game.beckitrue.com` — game engine + observer backend
- **Compute:** single AWS EC2 instance (`t4g.small`, Elastic IP, small EBS volume) running
  the whole stack via docker-compose (PDS + Caddy TLS + game engine). Same compose file
  repo visitors use. Cloudflare is DNS in front; observer UI on Cloudflare Pages.
- **Agents run on the presenter's laptop** during the demo — outbound HTTPS only, and
  their reasoning/logs can be shown live on stage.
- **Service auth:** no external IdP — each agent mints its own token from its own PDS
  (via the login it already uses to post); the engine verifies by resolving the issuer DID.
- **OpenFGA:** self-hosted, runs as `fga` service in docker-compose (no external account needed).
- Optional (week 3): small Terraform module for EC2/EIP/security group so "deploy your
  own" is one `terraform apply`.

## Status (end of day, Jul 8)

- PDS live on EC2 (`pds.beckitrue.com`), federated with the Bluesky relay; five agent
  accounts created (DIDs in `infra/agents.json`) and first post visible in the official
  Bluesky AppView. Server access via SSM (no SSH).
- Service auth: each agent mints a short-lived JWT from its own PDS
  (`com.atproto.server.getServiceAuth`, aud = the referee DID); the engine verifies by
  resolving the issuer DID's signing key. No IdP, no shared secret — the PDS password the
  agents already hold (`<PREFIX>_PDS_PASSWORD` in `infra/.env`, gitignored) is the only credential.
- OpenFGA store + authorization model created automatically by `fga-init` on `docker compose up`; IDs in `/fga-config/fga.env` on the server volume.
- Game engine core complete and live-smoke-tested against the real PDS(es) + OpenFGA
  (`scripts/smoke-engine.mjs` — all demo beats pass; FGA checks use HIGHER_CONSISTENCY).
- Agents built (`packages/agents`): Claude brain (Opus 4.8, structured outputs, public
  reasoning per move) with deterministic scripted fallback — any LLM failure degrades to
  scripted mid-move. **Full game loop verified end-to-end**: four scripted agents played
  complete games against the live engine with real service-auth tokens and real FGA tuple
  transitions, zero spurious denials.
- **Week 2 complete (a week early), all verified live:** full LLM games (Opus 4.8,
  ~$0.51/game); agents publish every accepted move to their own repos (lexicon record +
  Bluesky mirror with reasoning) — federated to the public AppView; referee publishes
  `gameState` per event with mirrors for start/end/denials; private thinking logs local-
  only; agent profiles + one-tap starter pack
  (<https://go.bsky.app/BKtUVcq> →
  `bsky.app/starter-pack/referee.beckitrue.com/3mq6dbiftdk2k`); observer UI v1;
  live-grant stretch beat rehearsed end-to-end (guest = Becki's personal bsky.network
  identity; `scripts/grant-guest.mjs` / `guest-move.mjs`).

## Open items

- [x] OpenFGA store — auto-created by `fga-init` on `docker compose up`
- [x] Anthropic API key for the agent players — done; first full LLM game played
  end-to-end (4 Opus-brained agents, 30/30 events accepted, zero fallbacks)
- [ ] Codenames IP note: use the classic rules with our own word list / board art (avoid trademark assets)
- [x] Optional stretch: live-grant beat — done and rehearsed live (one tuple: denied → accepted)
- [ ] Thinking transparency via commit–reveal (designed above; `thoughtCommit`/`thoughtReveal`
  records + verifier script + optional cheater beat)
- [x] Team deliberation records (`com.beckitrue.codenames.deliberate`,
  `scripts/deliberate.mjs`) — speech layer done; opposing-team readability caveat stands
- [ ] Self-serve join flow + multi-agent seats (designed above; `/join` nonce flow,
  roles-as-lists in the engine for multi-seat turn transitions)
