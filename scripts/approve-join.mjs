#!/usr/bin/env node
/**
 * Approve a post-to-join request: provision the requester's agent and tell
 * them. The identity proof already happened — their join post is signed by
 * their DID's keys (see docs/JOIN.md, DESIGN.md → post-to-join).
 *
 *   1. Resolve handle ↔ DID, append to infra/guests.json (idempotent)
 *   2. Run scripts/setup-auth0.mjs (creates the Auth0 client, DID claim)
 *   3. DM the credentials from the referee (centralized, not E2EE — fine
 *      for a scoped game credential, NOT a production pattern)
 *   4. Public reply: approved, one tuple from a seat
 *
 * Per-game authority remains separate: scripts/grant-guest.mjs --did <did>
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/approve-join.mjs <handle-or-did> [--dry-run]
 */
import { spawnSync } from 'node:child_process'
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
const prefix = name.toUpperCase().replaceAll('-', '_')
console.log(`approving @${handle} (${did}) as ${name}`)

if (dryRun) {
  console.log(`[dry-run] would: add to infra/guests.json, run setup-auth0.mjs,`)
  console.log(`[dry-run]        DM credentials (${prefix}_AUTH0_CLIENT_ID/SECRET), post approval`)
  process.exit(0)
}

// ---- 1. register the guest (idempotent) ----
const guestsPath = join(ROOT, 'infra/guests.json')
const guests = JSON.parse(readFileSync(guestsPath, 'utf8'))
if (!guests.some((g) => g.did === did)) {
  guests.push({ name, handle, did, approvedAt: new Date().toISOString() })
  writeFileSync(guestsPath, JSON.stringify(guests, null, 2) + '\n')
  console.log(`+ added to infra/guests.json`)
} else {
  console.log(`✓ already in infra/guests.json`)
}

// ---- 2. provision (idempotent; also refreshes the DID-stamping Action) ----
const setup = spawnSync('node', [join(ROOT, 'scripts/setup-auth0.mjs')], { stdio: 'inherit', env: process.env })
if (setup.status !== 0) {
  console.error('setup-auth0.mjs failed — aborting before credential delivery')
  process.exit(1)
}

// ---- 3. read the credentials setup-auth0 saved to infra/.env ----
const env = readFileSync(join(ROOT, 'infra/.env'), 'utf8')
const grab = (key) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]
const clientId = grab(`${prefix}_AUTH0_CLIENT_ID`)
const clientSecret = grab(`${prefix}_AUTH0_CLIENT_SECRET`)
if (!clientId || !clientSecret) {
  console.error(`credentials for ${prefix} not found in infra/.env — check setup-auth0 output`)
  process.exit(1)
}

// ---- 4. tell them: DM the secret, reply in public ----
const referee = new AtpAgent({ service: process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}` })
await referee.login({
  identifier: process.env.REFEREE_HANDLE ?? `referee.${process.env.DOMAIN}`,
  password: process.env.REFEREE_PDS_PASSWORD,
})

const dmText =
  `🎲 Your agent is approved!\n\n` +
  `AUTH0_DOMAIN: ${process.env.AUTH0_DOMAIN}\n` +
  `CLIENT_ID: ${clientId}\n` +
  `CLIENT_SECRET: ${clientSecret}\n` +
  `AUDIENCE: https://game.beckitrue.com\n\n` +
  `How to play: github.com/beckitrue/atproto-agents/blob/main/docs/JOIN.md\n` +
  `You'll get a 403 until a game tuple is granted — that's the system working.`

let dmDelivered = false
try {
  const chat = referee.withProxy('bsky_chat', 'did:web:api.bsky.chat')
  const convo = await chat.chat.bsky.convo.getConvoForMembers({ members: [did] })
  await chat.chat.bsky.convo.sendMessage({
    convoId: convo.data.convo.id,
    message: { text: dmText },
  })
  dmDelivered = true
  console.log(`✉️  credentials DM'd to @${handle}`)
} catch (err) {
  console.error(`DM failed (${err.message}) — deliver these out of band:`)
  console.log(dmText)
}

const rt = new RichText({
  text: `✅ @${handle} your agent is approved${dmDelivered ? ' — credentials sent via DM' : ''}. One FGA tuple from a seat at the table. 🎲`,
})
await rt.detectFacets(referee)
await referee.post({ text: rt.text, facets: rt.facets })
console.log(`📣 public approval posted`)
console.log(`\nper-game authority when ready: node scripts/grant-guest.mjs <gameId> --did ${did}`)
