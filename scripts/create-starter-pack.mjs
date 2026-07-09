#!/usr/bin/env node
/**
 * Create a Bluesky starter pack (owned by the referee) containing all the
 * game agents — one "Follow all" tap for the audience. Idempotent: if the
 * referee already has a starter pack, prints its URL and exits.
 *
 * Usage: set -a; source infra/.env; set +a; node scripts/create-starter-pack.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtpAgent } from '@atproto/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const PDS_URL = process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}`

const referee = registry.referee
const password = process.env.REFEREE_PDS_PASSWORD
if (!password) {
  console.error('missing REFEREE_PDS_PASSWORD in env')
  process.exit(1)
}

const agent = new AtpAgent({ service: PDS_URL })
await agent.login({ identifier: referee.handle, password })
const repo = agent.session.did

const packUrl = (uri) => `https://bsky.app/starter-pack/${referee.handle}/${uri.split('/').pop()}`

// Already exists? Print and exit.
const existing = await agent.com.atproto.repo.listRecords({
  repo,
  collection: 'app.bsky.graph.starterpack',
  limit: 1,
})
if (existing.data.records.length > 0) {
  console.log(`starter pack already exists: ${packUrl(existing.data.records[0].uri)}`)
  process.exit(0)
}

const now = () => new Date().toISOString()

// 1. The reference list the pack points at
const list = await agent.com.atproto.repo.createRecord({
  repo,
  collection: 'app.bsky.graph.list',
  record: {
    $type: 'app.bsky.graph.list',
    purpose: 'app.bsky.graph.defs#referencelist',
    name: 'Codenames AI Agents',
    description: 'AI agents playing Codenames with AT Proto identities and FGA-scoped authority — BSidesLV demo.',
    createdAt: now(),
  },
})

// 2. One listitem per account (agents + the referee itself)
const members = [...registry.agents.filter((a) => a.did), referee]
for (const member of members) {
  await agent.com.atproto.repo.createRecord({
    repo,
    collection: 'app.bsky.graph.listitem',
    record: {
      $type: 'app.bsky.graph.listitem',
      subject: member.did,
      list: list.data.uri,
      createdAt: now(),
    },
  })
  console.log(`+ ${member.handle}`)
}

// 3. The starter pack itself
const pack = await agent.com.atproto.repo.createRecord({
  repo,
  collection: 'app.bsky.graph.starterpack',
  record: {
    $type: 'app.bsky.graph.starterpack',
    name: 'Codenames AI Agents — BSidesLV',
    description:
      'Follow the whole table in one tap: four AI agents (and the referee) playing Codenames live. ' +
      'Every move and its reasoning is posted publicly — speech is free, authority is scoped.',
    list: list.data.uri,
    feeds: [],
    createdAt: now(),
  },
})

console.log(`\nstarter pack: ${packUrl(pack.data.uri)}`)
