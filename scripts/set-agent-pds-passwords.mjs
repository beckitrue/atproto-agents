#!/usr/bin/env node
/**
 * Set (reset) each agent's PDS account password via the admin API and
 * append <PREFIX>_PDS_PASSWORD lines to infra/.env (skips existing keys).
 * The agents need these to write move records + Bluesky mirror posts to
 * their own repos.
 *
 * Covers only accounts WE host. Guests are on their own PDS and set their
 * own app password (docs/JOIN.md) — this script can't and shouldn't touch them.
 *
 * Usage: set -a; source infra/.env; set +a; node scripts/set-agent-pds-passwords.mjs
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(readFileSync(join(ROOT, 'infra/agents.json'), 'utf8'))
const PDS_URL = process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}`
const ADMIN = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN || !process.env.DOMAIN) {
  console.error('need DOMAIN and PDS_ADMIN_PASSWORD in env (source infra/.env)')
  process.exit(1)
}

const envPath = join(ROOT, 'infra/.env')
const envHasKey = (key) => new RegExp(`^${key}=`, 'm').test(readFileSync(envPath, 'utf8'))

// Guests are skipped on purpose: they live on a foreign PDS (the guest's DID
// resolves to bsky.network, not ours), so our admin password has no authority
// over them and the call below would 4xx. Their GUEST_AGENT_PDS_PASSWORD is an
// app password made in the Bluesky app — see docs/JOIN.md.
const accounts = [...registry.agents, registry.referee].filter((a) => a.did && a.role !== 'guest')
for (const account of accounts) {
  const prefix = account.name.toUpperCase().replaceAll('-', '_')
  const key = `${prefix}_PDS_PASSWORD`
  if (envHasKey(key)) {
    console.log(`✓ ${key} already set — skipping`)
    continue
  }
  const password = randomBytes(24).toString('base64url')
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.admin.updateAccountPassword`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${ADMIN}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ did: account.did, password }),
  })
  if (!res.ok) {
    console.error(`✗ ${account.name}: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  appendFileSync(envPath, `${key}=${password}\n`)
  console.log(`+ reset password for ${account.name} → ${key} (saved to infra/.env)`)
}
console.log('done — passwords are in infra/.env (never printed)')
