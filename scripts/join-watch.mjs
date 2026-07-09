#!/usr/bin/env node
/**
 * Watch the referee's Bluesky notifications for join requests.
 * A mention of the referee containing "join" IS an identity-proved request:
 * the post is signed by the requester's DID keys.
 *
 * Usage: set -a; source infra/.env; set +a
 *        node scripts/join-watch.mjs            # check once, print the queue
 *        node scripts/join-watch.mjs --watch    # poll every 10s
 *        node scripts/join-watch.mjs --watch --approve   # auto-approve (talk mode)
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtpAgent } from '@atproto/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const autoApprove = process.argv.includes('--approve')

const PDS_URL = process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}`
const handle = process.env.REFEREE_HANDLE ?? `referee.${process.env.DOMAIN}`
const password = process.env.REFEREE_PDS_PASSWORD
if (!password) {
  console.error('missing REFEREE_PDS_PASSWORD in env')
  process.exit(1)
}

const agent = new AtpAgent({ service: PDS_URL })
await agent.login({ identifier: handle, password })
console.log(`watching @${handle} for "join" mentions${autoApprove ? ' (AUTO-APPROVE)' : ''}…`)

async function checkOnce() {
  const res = await agent.listNotifications({ limit: 50 })
  const requests = res.data.notifications.filter(
    (n) => n.reason === 'mention' && !n.isRead && /\bjoin\b/i.test(n.record?.text ?? ''),
  )
  for (const n of requests) {
    console.log(`\n📨 JOIN REQUEST from @${n.author.handle} (${n.author.did})`)
    console.log(`   "${(n.record?.text ?? '').replaceAll('\n', ' ')}"`)
    if (autoApprove) {
      const r = spawnSync('node', [join(ROOT, 'scripts/approve-join.mjs'), n.author.handle], {
        stdio: 'inherit',
        env: process.env,
      })
      if (r.status !== 0) console.error(`   approve failed for @${n.author.handle} — will not retry automatically`)
    } else {
      console.log(`   approve: node scripts/approve-join.mjs ${n.author.handle}`)
    }
  }
  if (requests.length > 0) {
    await agent.updateSeenNotifications(new Date().toISOString())
  }
  return requests.length
}

if (watch) {
  for (;;) {
    try {
      await checkOnce()
    } catch (err) {
      console.error(`poll failed (will retry): ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
} else {
  const n = await checkOnce()
  console.log(n === 0 ? 'no pending join requests' : `\n${n} request(s) queued`)
}
