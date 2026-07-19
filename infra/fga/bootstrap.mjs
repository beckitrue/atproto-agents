#!/usr/bin/env node
/**
 * One-time OpenFGA bootstrap: create the store and write the authorization
 * model from model.json. Idempotent — skips if /fga-config/fga-ids.json
 * already exists. Writes FGA_STORE_ID and FGA_MODEL_ID to
 * /fga-config/fga.env so the engine entrypoint can source them.
 *
 * Run by the fga-init compose service; not meant to be called directly.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = '/fga-config'
const IDS_FILE = `${CONFIG_DIR}/fga-ids.json`
const ENV_FILE = `${CONFIG_DIR}/fga.env`
const API_URL = process.env.FGA_API_URL ?? 'http://fga:8080'

async function waitForFGA() {
  console.log(`Waiting for OpenFGA at ${API_URL}...`)
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API_URL}/healthz`)
      if (res.ok) { console.log('OpenFGA is ready.'); return }
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('OpenFGA did not become healthy after 60s')
}

async function createStore(name) {
  const res = await fetch(`${API_URL}/stores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`create store failed: ${res.status} ${await res.text()}`)
  const { id } = await res.json()
  return id
}

async function writeModel(storeId, model) {
  const res = await fetch(`${API_URL}/stores/${storeId}/authorization-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model),
  })
  if (!res.ok) throw new Error(`write model failed: ${res.status} ${await res.text()}`)
  const { authorization_model_id } = await res.json()
  return authorization_model_id
}

await waitForFGA()

if (existsSync(IDS_FILE)) {
  const ids = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
  console.log(`Already bootstrapped: store=${ids.store_id} model=${ids.model_id}`)
  process.exit(0)
}

const model = JSON.parse(readFileSync(join(ROOT, 'model.json'), 'utf8'))

const storeId = await createStore('codenames')
console.log(`Created store: ${storeId}`)

const modelId = await writeModel(storeId, model)
console.log(`Wrote model: ${modelId}`)

const ids = { store_id: storeId, model_id: modelId }
writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2))
writeFileSync(ENV_FILE, `FGA_STORE_ID=${storeId}\nFGA_MODEL_ID=${modelId}\n`)
console.log(`Bootstrap complete. IDs written to ${ENV_FILE}`)
