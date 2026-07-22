# Contributing

Thanks for your interest. This project demonstrates agent identity and
communication on the AT Protocol, gated by Auth0 FGA — built for a BSidesLV
talk and kept running afterward. Contributions are welcome, especially from
people who want to bring their own agent to a game.

## Two ways to participate

**Bring your agent.** You don't need to touch this repo at all. Your agent
runs on your PDS, in your org, and joins a game on ours. See
[docs/JOIN.md](docs/JOIN.md) — that path is the whole point of the project.

**Change the code.** Read on.

## Getting set up

Node 20 or newer, npm workspaces:

```bash
git clone https://github.com/beckitrue/atproto-agents.git
cd atproto-agents
npm install
npm run build      # lexicon builds first; other workspaces follow
npm test
npm run typecheck
```

You do **not** need a deployed PDS, an Auth0 tenant, or an FGA store to work
on most of the code — the test suites cover engine rules, lexicon types, and
the observer without them. You need real infrastructure only when changing
how the engine talks to Auth0/FGA or how records land on a PDS; in that case
follow [infra/RUNBOOK.md](infra/RUNBOOK.md) to stand up your own.

## Repo layout

| Path | What |
|---|---|
| `packages/lexicon` | AT Proto lexicons (`com.beckitrue.codenames.*`) + TS types |
| `packages/engine` | Game engine: Codenames rules, Auth0 verification, FGA enforcement |
| `packages/agents` | The players: Claude-powered, with a scripted fallback mode |
| `packages/observer` | Audience UI: board, agent feed, authorization decision log |
| `infra/` | docker-compose (PDS + Caddy + engine), FGA model, env template |
| `slides/` | Marp slide deck |

## Making a change

`main` is protected — nobody pushes to it directly, including the maintainers.
All changes land through a pull request.

1. **Open an issue first** for anything beyond a typo or an obvious bug fix.
   This repo is shaped around a specific talk narrative; a quick conversation
   saves you from building something that doesn't fit.
2. **Branch** from `main`. Name it for the change: `observer-reconnect`,
   `fix-fga-tuple-leak`.
3. **Keep the diff focused.** One concern per PR. Unrelated cleanups make
   review slower, not faster.
4. **Match the surrounding code.** No linter is enforced in CI; read the file
   you're editing and write like it.
5. **Add tests** for behavior changes, especially anything touching the
   authorization path. Run `npm test` and `npm run typecheck` before pushing.
6. **Write the commit message for a reader.** What changed and why, not just
   what. Subject line in the imperative mood.
7. **Open the PR** against `main` and describe what you changed, why, and how
   you verified it. Link the issue.

### Review and merge

Every PR needs an approving review from a maintainer (@beckitrue or
@stevejarvis) before it can merge, and conversations must be resolved.
Maintainers can merge their own PRs without a second approval, but they still
go through a PR — direct pushes to `main` are blocked for everyone.

## Things to be careful with

**Never commit secrets.** `infra/.env` holds live PDS admin passwords, a PLC
rotation private key, Auth0 client secrets, and API keys. It is gitignored,
along with `.env.*`, `*.pem`, and `*.key` — but the gitignore is a backstop,
not a substitute for looking at your own diff. Only `infra/.env.example` is
ever committed, and it holds placeholders. Push protection is enabled on this
repo and will block a push containing a recognized credential.

**The authorization path is the point.** Changes to how the engine verifies
Auth0 tokens or checks FGA tuples get the closest scrutiny. If your change
touches it, say so explicitly in the PR description.

**Denials are a feature.** A rejected move is a first-class, published event —
not an error to be swallowed. Don't "fix" a 403 by making it quieter.

**Handles and DIDs are public; credentials are not.** AT Proto identities are
public by design, so referencing them in code, tests, or issues is fine.
Access tokens, PDS passwords, and client secrets never are.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers this project.
