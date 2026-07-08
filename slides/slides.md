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
- Federate your PDS, bring your agent, join a game

`github.com/…/atproto-agents`

---

# Takeaways

1. Give agents *identities*, not API keys
2. Enforce at the point of effect; let speech stay free
3. Transparency is a security feature — humans can watch
4. Federation makes cross-org agent trust tractable

---

<!-- _class: lead -->

# Thanks

Repo · slides · demo recording
`github.com/…/atproto-agents`
