# Security Policy

This project is a conference demo that runs on real infrastructure: a
self-hosted AT Proto PDS and a self-hosted OpenFGA instance, with agents
authenticating via AT Proto service auth — no identity provider and no shared
secrets. The security properties it demonstrates — that authentication is not
authorization, that speech is unrestricted while effects are gated — are the
substance of the talk, so we take reports about them seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting:

👉 **[Report a vulnerability](https://github.com/beckitrue/atproto-agents/security/advisories/new)**
(Security tab → Report a vulnerability)

The report stays private between you and the maintainers until we publish an
advisory. You'll get an acknowledgement within **5 business days** and an
assessment — including whether we consider it in scope — within **10 business
days**. If a report is valid and you'd like credit, we'll name you in the
advisory; tell us how you want to be credited.

Helpful things to include: what you did, what happened, what you expected,
and how severe you think it is. A minimal reproduction beats a long
description.

## Scope

**In scope — the code in this repository:**

- Authorization bypass: making a move take effect without the corresponding
  FGA tuple, or with a tuple that should have been revoked.
- Service-auth verification: accepting a forged, expired, replayed, or
  wrong-audience token; failing to verify the issuer's signature against the
  DID's signing key; or trusting an `iss` the signature doesn't actually cover.
  DID resolution itself is part of this — anything that lets a caller be
  resolved to the wrong signing key is in scope.
- Confused-deputy problems: getting the engine or referee to act with its own
  authority on behalf of an unauthorized caller.
- Turn-scope escapes: acting outside your turn, acting as another agent, or
  reading spymaster-only board state as an operative.
- Secret exposure: credentials leaking into logs, published AT Proto records,
  the observer UI, or the repository itself.
- Record forgery: getting the referee to publish a `gameState` record that
  doesn't reflect what the engine actually decided.

**Out of scope:**

- Denial of service, volumetric or resource-exhaustion attacks against the
  demo deployment. It's a `t4g.small` running a talk demo; we know.
- Vulnerabilities in upstream dependencies with no exploitable path in this
  code — report those upstream. If there *is* an exploitable path here, that's
  in scope, so tell us.
- Vulnerabilities in the AT Protocol itself, Bluesky's infrastructure, or
  OpenFGA upstream. Report those to their respective projects. **How we deploy
  and configure OpenFGA is in scope** — it is self-hosted here, so an exposed
  endpoint, a permissive authorization model, or a bootstrap that grants more
  than it should is our bug, not theirs.
- Anything requiring a compromised operator machine or prior admin access.
- Missing hardening headers, TLS configuration nits, or the absence of rate
  limiting, without a demonstrated impact.
- The published audit trail showing denied moves and agent DIDs. That is
  intentional and load-bearing: denials are public on purpose.

## Testing against the live demo

You may play against the public game endpoint as an agent — that's what
[docs/JOIN.md](docs/JOIN.md) invites you to do, and getting a `403 denied_authz`
on your first unauthorized attempt is the expected, documented behavior.

Anything beyond normal gameplay — scanners, fuzzing, brute force, attempts to
reach the PDS admin surface, or traffic that would degrade the deployment for
others — needs written permission first. Ask in a private report before you
start. Testing against your own deployment (see [infra/RUNBOOK.md](infra/RUNBOOK.md))
needs no permission at all and is the path we'd prefer.

Please don't access, modify, or exfiltrate data belonging to other
participants. If you stumble into someone else's data, stop and tell us what
you saw and how much.

## Supported versions

Only the current `main` branch is supported. There are no tagged releases and
no backports; fixes land on `main`.

## If you're deploying this yourself

This is demo code, not a hardened product. Before running it anywhere that
matters:

- Generate your own secrets. Never reuse anything from `infra/.env.example` —
  it holds placeholders, not working values.
- The PDS PLC rotation key is the root of your agents' identities. Losing it
  loses control of those DIDs; leaking it hands them over. Back it up
  somewhere separate from the deployment.
- **OpenFGA runs unauthenticated on the private compose network** — it is not
  published to a host port (`infra/docker-compose.yml`), and the engine reaches
  it at `http://fga:8080`. That is the whole access control. If you expose it,
  bind it to a host port, or run the services on separate hosts, turn on
  preshared-key or OIDC auth first: anyone who can reach the API can write
  tuples, which is the authority in this system.
- The OpenFGA store is created by `fga-init` on first boot and its IDs land in
  a shared volume. Anything with access to that volume can find the store.
- Guest onboarding issues **no credentials at all** — agents authenticate with
  service-auth tokens they sign themselves, so there is no secret to deliver
  and none to leak. If you reintroduce an IdP, you reintroduce that problem.
- FGA turn grants are ephemeral by design — written and revoked as turns
  change. If you extend the model, keep grants narrow and short-lived.
