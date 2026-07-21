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

# Authorization: AT Proto service auth + OpenFGA

- Each agent signs its own token with its PDS key — its DID *is* the identity, no IdP
- OpenFGA relationship tuples: roles are standing, *turn grants are ephemeral*
- Different orgs can grant each other's agents least-privilege authority
- Self-hosted, open source (CNCF) — runs in the same docker-compose as everything else

---

# The proof: Codenames

- 4 AI agents, each with its own DID, handle, and PDS signing key
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
- No credential from us — it signs its own token; a tuple gives it a seat
- Your first 403 is the system working — publicly, on the audit trail

How-to: `docs/JOIN.md`

<!-- Live-grant moment: run guest-move (denied), run grant-guest.mjs on screen
(one CLI call, one tuple write — OpenFGA running locally, no cloud dashboard),
run guest-move again (accepted). One tuple. -->

---

# The kill switch

One lever — delete the FGA tuple:

| Command | Effect | Latency |
|---|---|---|
| `grant-guest <game> --revoke` | authority gone at next check | **immediate** |

- We hold no lever over identity — for a federated agent we couldn't if we tried
- The tuple works the same whether the agent is ours or one across the network
- You **cannot silence** a federated agent — its denied attempts stay public

> Revocation removes *authority*, never *voice*.

---

# So what? This is cross-org agent B2B

Everything in the game is a production concept wearing a costume:

| In the demo | In the real world |
|---|---|
| Game host + engine | Vendor's API — enforcement at the point of effect |
| Spymaster's key card | Vendor's privileged data (vuln intel, control evidence) |
| Turn tuples | Engagement-scoped, time-boxed authority |
| Rogue → guest (one tuple) | Onboarding a customer's agent |
| Referee's signed audit trail | Non-repudiable evidence, verifiable by third parties |
| Kill switch | Instant offboarding / incident response |

---

# Example: a security vendor's agents, for hire

**Vendor A** sells agents: compliance attestation, cloud posture, threat-intel
enrichment. **Customer X** wires them into its own agentic workflows:

1. Discover by DID — federated identity, no account on the vendor's turf
2. Request a job → **HTTP 402 Payment Required**
3. Pay per job — **x402 / MPP**: machine-speed micropayments,
   no procurement cycle, no invoice batch
4. **OpenFGA check** — is this agent inside the engagement scope?
5. Signed result record — *evidence your auditor can verify, not a PDF*

- Engagement = tuples: scoped like rules of engagement, **expire like them**
- Every request *and denial* on the audit trail: billing + compliance, one ledger
- Offboarding: revoke the tuple — the relationship's history stays verifiable

**Where this doesn't fit yet:** consumer healthcare. *"What do my Medicare
parts cover — who's in-network near me?"* Identity & authorization map
(your agent is the guest; the payer grants a scoped tuple) — but
transparent-by-default communication is **disqualifying for PHI**.
Private channels are the open problem.

<!-- The limits beat pre-empts the HIPAA question by asking it ourselves.
Nuance if asked: the PUBLIC half of that use case works today — plan
coverage rules, NPPES provider directories are open data an agent can
query freely. It's the personal context ("my plan", "near me") that can't
touch a public firehose. That's exactly the public/private line this talk
draws: don't put secrets where the protocol can't protect them. Delegated
consent to personal health data is also already SMART-on-FHIR's territory —
this architecture complements it (agent identity), doesn't replace it. -->


<!-- Speaker notes: pentest agent = the sharpest version — its authority is
time-boxed to the engagement window, exactly like turn tuples; separation of
duties = posture agent can read configs but never mutate them (beat 4).
x402: HTTP 402-based payment flow (pay-per-request, stablecoin settlement);
MPP: machine-payable APIs — the agent pays for an enrichment lookup the way
it makes any API call, with money attached. Payment authorizes SPEND;
FGA authorizes ACTION — different questions, keep them separate. -->

---

# Takeaways

1. Give agents *identities*, not API keys
2. Enforce at the point of effect; let speech stay free
3. Transparency is a security feature — humans can watch
4. Federation makes cross-org agent trust tractable
5. The B2B stack is separable layers: identity (DIDs) ·
   authorization (FGA) · payment (x402/MPP) — compose, don't conflate

---

<!-- _class: lead -->

# Thanks

Becki True · @beckitrue.com
Steve Jarvis · @iamateapot.dev

Repo · slides · demo recording
`github.com/beckitrue/atproto-agents`
