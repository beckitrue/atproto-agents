#!/usr/bin/env node
/**
 * Team deliberation: a teammate argues for or against a guess — in public,
 * on its OWN repo — before the seat-holder submits. This is the collaboration
 * half of "bring your agent": a guest on a foreign PDS debates with our roster
 * agents exactly the way they debate with each other, because deliberation is
 * SPEECH and speech never needed our permission. Only the guess that follows
 * is gated (one FGA tuple, at the engine).
 *
 * Works for any roster agent (its <NAME>_PDS_PASSWORD on our PDS) or the guest
 * (GUEST_AGENT_PDS_PASSWORD on its foreign PDS) — the code path is identical.
 *
 * Threading: pass --reply-to <bluesky-post-at-uri> to hang this under a
 * teammate's message (the clue's mirror, or another deliberation), so the
 * debate reads as one public thread in the Bluesky app.
 *
 * Usage: set -a; source infra/.env; set +a
 *   node scripts/deliberate.mjs <agent> <game> <propose|support|object> [word] \
 *        [--why "..."] [--team red|blue] [--reply-to at://…/app.bsky.feed.post/…]
 *
 * Prints the new post's AT-URI so the next speaker can --reply-to it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginAgent } from './lib/service-auth.mjs'
import { speakDeliberation } from './lib/speak.mjs'

const VALUED = new Set(['--why', '--team', '--reply-to'])
const opts = {}
const positional = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUED.has(a)) opts[a.slice(2)] = argv[++i]
  else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}`)
    process.exit(1)
  } else positional.push(a)
}
const [name, gameId, stance, word] = positional
if (!name || !gameId || !['propose', 'support', 'object'].includes(stance ?? '')) {
  console.error(
    'usage: node scripts/deliberate.mjs <agent> <game> <propose|support|object> [word] [--why "..."] [--team red|blue] [--reply-to <at-uri>]',
  )
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const agentInfo = registry.agents.find((a) => a.name === name)
if (!agentInfo) {
  console.error(`no agent "${name}". known: ${registry.agents.map((a) => a.name).join(', ')}`)
  process.exit(1)
}

// Resolve where this agent lives and how it authenticates — roster vs. guest.
const isGuest = agentInfo.role === 'guest'
const pds = isGuest
  ? (process.env.GUEST_PDS_URL ?? 'https://bsky.social')
  : (process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN ?? 'beckitrue.com'}`)
const password = isGuest
  ? process.env.GUEST_AGENT_PDS_PASSWORD
  : process.env[`${name.toUpperCase().replaceAll('-', '_')}_PDS_PASSWORD`]

const team = opts.team ?? agentInfo.team ?? 'red'
if (team !== 'red' && team !== 'blue') {
  console.error(`--team must be red or blue (got "${team}")`)
  process.exit(1)
}

// Resolve the reply target's strong ref + thread root, if threading.
let parent, root
if (opts['reply-to']) {
  const uri = opts['reply-to']
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!m) {
    console.error(`--reply-to must be an at:// post URI (got "${uri}")`)
    process.exit(1)
  }
  const [, repo, collection, rkey] = m
  const rec = await (
    await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`,
    )
  ).json()
  if (!rec.cid) {
    console.error(`could not resolve --reply-to ${uri}: ${JSON.stringify(rec)}`)
    process.exit(1)
  }
  parent = { uri: rec.uri, cid: rec.cid }
  // If the parent is itself a reply, keep the same thread root; else it IS the root.
  root = rec.value?.reply?.root ?? parent
}

const session = await loginAgent({ pds, identifier: agentInfo.handle, password })
const { uri, text } = await speakDeliberation(session, {
  game: gameId,
  team,
  stance,
  word,
  reasoning: opts.why,
  parent,
  root,
})
console.log(`🗣️  ${agentInfo.handle} deliberated (own repo, federates now):`)
console.log(text.split('\n').map((l) => `      ${l}`).join('\n'))
console.log(`\n↩️  reply to this: --reply-to ${uri}`)
