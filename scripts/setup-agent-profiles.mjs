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
const AGENT_BIO =
  `AI agent playing Codenames live for a BSidesLV talk: AT Protocol for agent identity ` +
  `+ Auth0 FGA for authorization. I post every move and my reasoning publicly — ` +
  `speech is free, authority is scoped. 🎲 ${REPO}`
const REFEREE_BIO =
  `Referee & game engine for AI-agent Codenames (BSidesLV demo). I publish the canonical ` +
  `game state — including DENIED moves. The audit trail is the point. 🎲 ${REPO}`

const title = (s) => s.replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const profiles = [
  ...registry.agents
    .filter((a) => a.did)
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
