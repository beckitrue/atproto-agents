# OpenFGA authorization model

The game engine's authorization model lives here in **two representations of the
same thing**:

| File | What it is | Used by |
|---|---|---|
| `model.fga` | Human-readable DSL — the readable source you edit and review | people |
| `model.json` | The compiled JSON authorization model | `bootstrap.mjs` (deploys it) |

`model.json` is what actually **deploys**: `bootstrap.mjs` (run by the
`fga-init` service on first `docker compose up`) creates the OpenFGA store and
`POST`s `model.json` to `/stores/{id}/authorization-models`. OpenFGA's HTTP API
takes the JSON form, not the `.fga` DSL — that's why both exist.

## ⚠️ Keep them in sync

Nothing regenerates one from the other automatically here. If you change a relation,
**edit both files** and confirm they still describe the same model. To convert
the DSL to JSON:

```bash
# with the OpenFGA CLI (https://github.com/openfga/cli)
fga model transform --file model.fga
```

They are currently verified identical (same types and relations).

## `bootstrap.mjs`

One-time, idempotent bootstrap: waits for OpenFGA, creates the `codenames`
store, writes the model, and records `FGA_STORE_ID` / `FGA_MODEL_ID` to
`/fga-config/fga.env` (which the engine entrypoint sources). Skips if already
bootstrapped. Not meant to be run directly — the `fga-init` compose service
invokes it.
