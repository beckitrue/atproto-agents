#!/usr/bin/env node
/**
 * Acknowledge a post-to-join request — the operator's "welcome" step. This
 * deliberately does NOT authenticate the guest and does NOT let it play:
 *
 *   - Authentication is self-service and not ours: the guest signs its own
 *     service-auth token with its DID's keys, on its own PDS. Nothing to
 *     provision, nothing to hand over.
 *   - A seat in a game is a separate, per-game FGA tuple — the thing that
 *     actually grants authority: scripts/grant-guest.mjs <gameId> --did <did>
 *
 * So all this does is the human welcome:
 *   1. Resolve handle ↔ DID and record it on the guest list (infra/guests.json
 *      — an audit/roster log; nothing reads it to authorize).
 *   2. Post a public reply from the referee acknowledging the request.
 *
 * (The identity proof already happened: their join post is signed by their
 * DID's keys — see docs/JOIN.md, DESIGN.md → post-to-join.)
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/approve-join.mjs <handle-or-did> [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtpAgent, RichText } from '@atproto/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const who = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
if (!who) {
  console.error('usage: node scripts/approve-join.mjs <handle-or-did> [--dry-run]')
  process.exit(1)
}

// ---- resolve handle <-> DID via the public AppView ----
let did, handle
if (who.startsWith('did:')) {
  did = who
  const prof = await (
    await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${who}`)
  ).json()
  handle = prof.handle
} else {
  handle = who.replace(/^@/, '')
  const res = await (
    await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`)
  ).json()
  did = res.did
  if (!did) {
    // resolveHandle/getProfile can fail on stale handle-verification states
    // even when the account exists — the search index is more forgiving.
    // (Seen in the wild during rehearsal.) Exact-match only.
    const search = await (
      await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${handle}&limit=5`)
    ).json()
    const hit = (search.actors ?? []).find((a) => a.handle === handle)
    if (hit) did = hit.did
  }
}
if (!did || !handle) {
  console.error(`could not resolve "${who}"`)
  process.exit(1)
}

const name = `guest-${handle.replaceAll('.', '-')}`
console.log(`welcoming @${handle} (${did}) as ${name}`)

if (dryRun) {
  console.log(`[dry-run] would: add ${name} (${did}) to the guest list, post public acknowledgement`)
  process.exit(0)
}

// ---- 1. add to the guest list (audit/roster log — not an authorization gate) ----
const guestsPath = join(ROOT, 'infra/guests.json')
const guests = JSON.parse(readFileSync(guestsPath, 'utf8'))
if (!guests.some((g) => g.did === did)) {
  guests.push({ name, handle, did, welcomedAt: new Date().toISOString() })
  writeFileSync(guestsPath, JSON.stringify(guests, null, 2) + '\n')
  console.log(`+ added to infra/guests.json`)
} else {
  console.log(`✓ already on the guest list`)
}

// ---- 2. public acknowledgement from the referee (no secret to deliver) ----
const referee = new AtpAgent({ service: process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}` })
await referee.login({
  identifier: process.env.REFEREE_HANDLE ?? `referee.${process.env.DOMAIN}`,
  password: process.env.REFEREE_PDS_PASSWORD,
})

const rt = new RichText({
  text:
    `👋 @${handle} welcome to the table. Your agent authenticates itself — a token it ` +
    `signs with its own keys, nothing from us. A seat in a game is one FGA tuple away. ` +
    `🎲 How to play: github.com/beckitrue/atproto-agents/blob/main/docs/JOIN.md`,
})
await rt.detectFacets(referee)
await referee.post({ text: rt.text, facets: rt.facets })
console.log(`📣 public acknowledgement posted`)
console.log(`\ngrant a seat when ready: node scripts/grant-guest.mjs <gameId> --did ${did}`)
