---
marp: true
theme: default
paginate: true
title: "Agents Need Passports: Identity & Authorization for AI Agents with AT Protocol"
---

<!-- _class: lead -->

# Agents Need Passports

## Identity & authorization for AI agents, built on the AT Protocol

BSidesLV · August 2026
Becki True · @beckitrue.com
Steve Jarvis · @iamateapot.bsky.social

---

# The problem

- Agents are everywhere; agent *identity* is nowhere
- API keys are not identities: unscoped, unauditable, unportable
- Agent-to-agent communication happens in the dark
- Cross-organization agent trust has no shared substrate

<!-- Speaker notes: open with a concrete horror story — an agent with a
god-mode API key. What would "least privilege for agents" even look like? -->

---

# Why the AT Protocol

| Need | AT Proto gives us |
|---|---|
| Portable identity | DIDs — cryptographic, org-independent |
| Verifiable communication | Signed public data repos |
| Human oversight | Every message is observable (it's Bluesky!) |
| Cross-org interop | Federation |

---

# Speech is free; authority is scoped

- The protocol can't stop an agent from *saying* anything — by design
- Authorization lives at the **point of effect**, not in the transport
- Attempts are public; effects are gated; denials are auditable

<!-- The core architectural claim of the talk. -->

---

# Authorization: Auth0 + FGA

- Each agent: an Auth0 M2M client, DID as a token claim
- FGA relationship tuples: roles are standing, *turn grants are ephemeral*
- Different orgs can grant each other's agents least-privilege authority

---

# The proof: Codenames

- 4 AI agents, each with its own DID, handle, and Auth0 credentials
- Turn-scoped permissions: you can act only during your turn
- Every clue and guess is a signed record — watch the game in Bluesky

---

# Demo

| # | Beat | Shows |
|---|---|---|
| 1 | Clue, on turn | ✅ token + tuple + turn |
| 2 | Clue, off turn | ⛔ time-scoped authority |
| 3 | Operative reads key | ⛔ role-scoped data |
| 4 | Spymaster guesses | ⛔ separation of duties |
| 5 | Foreign-PDS agent | 🗣️ visible, ⛔ powerless |

---

# Beat 5 is the invitation

- The rogue and the guest use the **same mechanism**
- Rogue → guest = one FGA tuple grant
- Bring a DID from *any* PDS — your `bsky.social` account works
- We bind it to a token claim; a tuple gives it a seat
- Your first 403 is the system working — publicly, on the audit trail

How-to: `docs/JOIN.md`

<!-- Live-grant moment: run guest-move (denied), grant the tuple in the FGA
dashboard on screen, run guest-move again (accepted). One tuple. -->

---

# The kill switch

Revocation is layered — fastest first:

| Layer | Effect | Latency |
|---|---|---|
| FGA tuple delete | authority gone at next check | **immediate** |
| Auth0 grant delete | no new tokens | in-flight tokens ≤1h |
| DID claim unmap | tokens lose identity → 401 | same caveat |

- Tuples first — they cover the token-expiry window
- You **cannot silence** a federated agent — its repo is its own
- Its denied attempts stay on the public record (referee narrates)

> Revocation removes *authority*, never *voice*.

---

# Takeaways

1. Give agents *identities*, not API keys
2. Enforce at the point of effect; let speech stay free
3. Transparency is a security feature — humans can watch
4. Federation makes cross-org agent trust tractable

---

<!-- _class: lead -->

# Thanks

Becki True · @beckitrue.com
Steve Jarvis · @iamateapot.bsky.social

Repo · slides · demo recording
`github.com/beckitrue/atproto-agents`
