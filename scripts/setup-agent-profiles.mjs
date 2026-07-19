#!/usr/bin/env node
/**
 * Set each agent's Bluesky profile: display name, bio, and avatar.
 * Idempotent — safe to re-run (upsertProfile merges).
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/setup-agent-profiles.mjs <avatar-dir>
 *   <avatar-dir> contains <agent-name>.png files (optional; skipped if absent)
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtpAgent } from '@atproto/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const PDS_URL = process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}`
const avatarDir = process.argv[2]

const REPO = 'github.com/beckitrue/atproto-agents'
const OBSERVER = 'observer.beckitrue.com'

// Bluesky bios cap at 256 graphemes, so the observer link is paid for by
// trimming prose, not appended. Bare domains (no scheme) match the existing
// repo link and are linkified by the app.
const AGENT_BIO =
  `AI agent playing Codenames live for a BSidesLV talk: AT Proto identity + OpenFGA ` +
  `authorization. Every move and my reasoning, posted publicly — speech is free, ` +
  `authority is scoped.\n\n👀 ${OBSERVER}\n🎲 ${REPO}`
const REFEREE_BIO =
  `Referee & game engine for AI-agent Codenames (BSidesLV). I publish the canonical ` +
  `game state — including DENIED moves. The audit trail is the point.` +
  `\n\n👀 Watch live: ${OBSERVER}\n🎲 ${REPO}`

/** Bluesky counts graphemes, not code units; emoji would undercount otherwise. */
const graphemes = (str) =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)].length
for (const [name, bio] of [['AGENT_BIO', AGENT_BIO], ['REFEREE_BIO', REFEREE_BIO]]) {
  if (graphemes(bio) > 256) {
    console.error(`✗ ${name} is ${graphemes(bio)}/256 graphemes — Bluesky will reject it`)
    process.exit(1)
  }
}

const title = (s) => s.replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const profiles = [
  ...registry.agents
    // NEVER the guest: its handle is Becki's PERSONAL account (beckitrue.com),
    // and upsertProfile would replace her real name and bio with "Guest Agent".
    // Today only a missing GUEST_AGENT_PDS_PASSWORD prevents that — this makes
    // it deliberate rather than accidental.
    .filter((a) => a.did && a.role !== 'guest')
    .map((a) => ({
      name: a.name,
      handle: a.handle,
      displayName: `${title(a.name)} ${a.role === 'spymaster' ? '🕵️' : '🎯'}`,
      description: AGENT_BIO,
    })),
  {
    name: registry.referee.name,
    handle: registry.referee.handle,
    displayName: 'Referee 🎲',
    description: REFEREE_BIO,
  },
]

for (const p of profiles) {
  const prefix = p.name.toUpperCase().replaceAll('-', '_')
  const password = process.env[`${prefix}_PDS_PASSWORD`]
  if (!password) {
    console.error(`✗ ${p.name}: missing ${prefix}_PDS_PASSWORD in env`)
    continue
  }
  const agent = new AtpAgent({ service: PDS_URL })
  await agent.login({ identifier: p.handle, password })

  let avatar
  const avatarPath = avatarDir && join(avatarDir, `${p.name}.png`)
  if (avatarPath && existsSync(avatarPath)) {
    const res = await agent.uploadBlob(readFileSync(avatarPath), { encoding: 'image/png' })
    avatar = res.data.blob
  }

  await agent.upsertProfile((existing) => ({
    ...existing,
    displayName: p.displayName,
    description: p.description,
    ...(avatar ? { avatar } : {}),
  }))
  console.log(`✓ ${p.handle}: "${p.displayName}"${avatar ? ' + avatar' : ''}`)
}
