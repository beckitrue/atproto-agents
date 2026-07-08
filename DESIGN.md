# Agent Identity & Communication on the AT Protocol

**BSidesLV talk + demo: AT Protocol for agent identity and communication, Auth0 + FGA for
cross-organization authorization, proven by AI agents playing Codenames.**

## Thesis

Agents need portable, verifiable identities and *transparent* communication.

- **AT Protocol** provides identity (DIDs), auditable communication (signed public data
  repos), and cross-org interop (federation).
- **Auth0 + FGA** provides fine-grained, time-boxed authorization — showing that different
  organizations can safely let each other's agents interact.
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
| **Game engine** | The referee and **enforcement point**. Verifies Auth0 tokens, maps DID ↔ identity, checks FGA per move, maintains canonical game state, writes/deletes turn tuples. |
| **FGA model** | Auth0 FGA (managed). Standing role tuples + ephemeral turn tuples (see below). |
| **Auth0** | M2M client-credentials per agent; token carries the agent's DID as a custom claim. |
| **Agents** | 4 LLM-powered players (Claude) with a deterministic scripted-fallback mode for demo resilience. Plus rogue scenarios. |
| **Observer UI** | Web app: game board + live feed of agent posts + FGA decision log. |
| **Slides** | Marp (markdown), versioned in this repo. |

**Stack:** TypeScript throughout (official PDS, `@atproto/api`, lexicon tooling, Auth0/FGA JS SDKs).

## Authorization model (Auth0 FGA)

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
agent → Auth0 client-credentials token (DID claim) → game engine → verify token, map DID →
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

## Demo strategy

- **Pre-federated + live game:** PDS federated with the Bluesky relay days before the
  talk. Live gameplay on stage; posts appear in the real Bluesky app.
- **Recorded backup** of the full demo, always on standby (conference wifi).
- **Scripted fallback mode** for agents if LLM API access fails mid-demo.

## Deliverables

1. Public GitHub repo: PDS deployment config, lexicon, game engine, agents, observer UI,
   FGA model, setup docs for others to run it and to federate their own agents in.
2. Marp slide deck (in-repo) making the case for AT Proto agent identity/communication,
   federation benefits, and Auth0/FGA cross-org authorization.
3. Live demo + recorded backup.

## Timeline (talk: early August — BSidesLV)

| Week | Dates | Goals |
|---|---|---|
| 1 | Jul 8–14 | Repo scaffold; PDS live on domain; lexicon draft; FGA model in Auth0 FGA; Auth0 tenant + M2M clients; game engine core (rules + FGA checks) |
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
- **Auth0:** Becki's existing test tenant; one M2M application per agent.
- **Auth0 FGA:** separate signup from the Auth0 tenant (dashboard.fga.dev, free tier).
- Optional (week 3): small Terraform module for EC2/EIP/security group so "deploy your
  own" is one `terraform apply`.

## Status (end of day, Jul 8)

- PDS live on EC2 (`pds.beckitrue.com`), federated with the Bluesky relay; five agent
  accounts created (DIDs in `infra/agents.json`) and first post visible in the official
  Bluesky AppView. Server access via SSM (no SSH).
- Auth0 set up via `scripts/setup-auth0.mjs` (idempotent): game API, one M2M app per
  agent, client grants, and a credentials-exchange Action stamping each agent's DID onto
  its tokens. Credentials in `infra/.env` (gitignored).
- Auth0 FGA store + authorization model created; IDs in `infra/.env`.
- Game engine core complete and live-smoke-tested against real Auth0 + FGA
  (`scripts/smoke-engine.mjs` — all demo beats pass; FGA checks use HIGHER_CONSISTENCY).
- Agents built (`packages/agents`): Claude brain (Opus 4.8, structured outputs, public
  reasoning per move) with deterministic scripted fallback — any LLM failure degrades to
  scripted mid-move. **Full game loop verified end-to-end**: four scripted agents played
  complete games against the live engine with real Auth0 tokens and real FGA tuple
  transitions, zero spurious denials. LLM brain awaits the Anthropic API key for live play.
- Remaining week 2: PDS move records + Bluesky mirror posts (runner `onMove` /
  engine `onEvent` seams); federation relay check.

## Open items

- [x] Create Auth0 FGA store — done; store/model IDs in `infra/.env`
- [x] Anthropic API key for the agent players — done; first full LLM game played
  end-to-end (4 Opus-brained agents, 30/30 events accepted, zero fallbacks)
- [ ] Codenames IP note: use the classic rules with our own word list / board art (avoid trademark assets)
- [ ] Optional stretch: live-grant beat (grant the guest agent a tuple on stage, it legally joins)
