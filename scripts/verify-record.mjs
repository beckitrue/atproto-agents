#!/usr/bin/env node
/**
 * Verify a record's signature WITHOUT trusting our game engine — the Phase C
 * moment. Give it the AT-URI of any record (e.g. the guest's guess on its
 * foreign PDS) and it:
 *
 *   1. RESOLVES the author's DID through plc.directory → signing key + PDS.
 *      The DID *is* the identity; no IdP, no shared secret, no call to us.
 *   2. PULLS a cryptographic proof straight from the author's PDS
 *      (com.atproto.sync.getRecord → a CAR: the signed repo commit plus the
 *      Merkle-tree path down to this one record).
 *   3. VERIFIES the commit signature against the DID's key, checks every block
 *      hashes to its CID (no tampering), and proves the record is committed by
 *      walking the signed Merkle tree to the record's CID.
 *
 * Nothing here talks to game.beckitrue.com. If the engine vanished, this still
 * proves the guest signed exactly this guess. Authentication is the DID +
 * signature; the engine only ever decided *authorization* (the FGA tuple).
 *
 * No engine trust, no extra services — just @atproto/{identity,crypto,common}
 * and multiformats, the same primitives the network itself uses.
 *
 * Usage:
 *   node scripts/verify-record.mjs <at-uri>
 *
 * Example (the guest's DRAGON guess on its foreign bsky.network PDS):
 *   node scripts/verify-record.mjs \
 *     at://did:plc:dto65vuytpsqohl65b7ndc4r/com.beckitrue.codenames.guess/3mrs6ltbxsq2g
 */
import { CID } from 'multiformats/cid'
import { cborDecode, cborEncode, verifyCidForBytes } from '@atproto/common'
import { verifySignature } from '@atproto/crypto'
import { IdResolver } from '@atproto/identity'

const uriArg = process.argv[2]
if (!uriArg || uriArg === '-h' || uriArg === '--help') {
  console.error('usage: node scripts/verify-record.mjs <at-uri>')
  console.error('  e.g. at://did:plc:dto65vuytpsqohl65b7ndc4r/com.beckitrue.codenames.guess/3mrs6ltbxsq2g')
  process.exit(uriArg ? 0 : 1)
}

// Parse at://<authority>/<collection>/<rkey>. Authority may be a DID or handle.
const m = /^(?:at:\/\/)?([^/]+)\/([^/]+)\/([^/]+)$/.exec(uriArg.trim())
if (!m) {
  console.error(`not an at-uri with collection + rkey: ${uriArg}`)
  process.exit(1)
}
const [, authority, collection, rkey] = m

const fail = (msg) => {
  console.error(`\n❌ ${msg}`)
  process.exit(1)
}

// ── 1. Resolve the identity — DID → signing key + PDS, via plc.directory ──────
// PLC_DIRECTORY_URL can point at a dev PLC; unset → the public plc.directory.
const idr = new IdResolver(process.env.PLC_DIRECTORY_URL ? { plcUrl: process.env.PLC_DIRECTORY_URL } : {})

let did = authority
if (!authority.startsWith('did:')) {
  did = await idr.handle.resolve(authority).catch(() => null)
  if (!did) fail(`could not resolve handle to a DID: ${authority}`)
}

const id = await idr.did.resolveAtprotoData(did).catch((e) => fail(`DID resolution failed: ${e.message}`))

console.log('🔎 Resolved identity (no engine involved):')
console.log(`   DID         ${id.did}`)
console.log(`   handle      ${id.handle}`)
console.log(`   PDS         ${id.pds}`)
console.log(`   signing key ${id.signingKey}`)
console.log(`   record      ${collection}/${rkey}`)

// ── 2. Pull the proof straight from the author's PDS ─────────────────────────
// getRecord returns a CAR: the signed commit + the Merkle path to this record.
const url = `${id.pds}/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(did)}` +
  `&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`
const res = await fetch(url)
if (!res.ok) fail(`PDS getRecord returned ${res.status} ${res.statusText}`)
const car = parseCar(new Uint8Array(await res.arrayBuffer()))
console.log(`\n📦 Proof from ${new URL(id.pds).host}: ${car.blocks.size} blocks, root ${car.roots[0]}`)

// Every block must hash to its own CID — content-addressed, so this alone
// makes the bytes un-tamperable once the root is pinned by a signature.
for (const { cid, bytes } of car.blocks.values()) {
  await verifyCidForBytes(cid, bytes).catch(() => fail(`block ${cid} does not match its bytes — tampered proof`))
}

// ── 3. Verify the commit signature against the resolved key ──────────────────
const rootCid = car.roots[0]
const commitBlock = car.blocks.get(rootCid.toString())
if (!commitBlock) fail('proof is missing its root commit block')
const commit = cborDecode(commitBlock.bytes)
const unsigned = { ...commit }
delete unsigned.sig
const sigOk = await verifySignature(id.signingKey, cborEncode(unsigned), commit.sig)
  .catch((e) => fail(`signature check errored: ${e.message}`))
if (!sigOk) fail('commit signature is INVALID — the DID did not sign this repo state')
console.log(`\n🔏 Commit rev ${commit.rev} signed by ${id.did}`)
console.log('   signature VALID ✓  (checked against the DID\'s key, not the engine\'s word)')

// ── 4. Prove the record is committed — walk the signed Merkle tree ───────────
// Reachable from the signed root via verified CID links ⇒ the signature covers
// it. Any tampering would break a CID (step above) or the signature (step 3).
const reachable = new Set()
const stack = [commit.data.toString()]
while (stack.length) {
  const c = stack.pop()
  if (reachable.has(c)) continue
  reachable.add(c)
  const blk = car.blocks.get(c)
  if (!blk) continue
  const node = cborDecode(blk.bytes)
  if (node?.l) stack.push(node.l.toString())
  for (const e of node?.e ?? []) {
    if (e?.v) stack.push(e.v.toString())
    if (e?.t) stack.push(e.t.toString())
  }
}

// The record leaf is the block whose content is our record.
let record = null
let recordCid = null
for (const { cid, bytes } of car.blocks.values()) {
  let val
  try { val = cborDecode(bytes) } catch { continue }
  if (val && val['$type'] === collection) {
    record = val
    recordCid = cid.toString()
  }
}
if (!record) fail(`no ${collection} record found in the proof`)
if (!reachable.has(recordCid)) fail('record is NOT committed under the signed Merkle root')

console.log(`\n📄 Record ${recordCid}`)
console.log('   committed under the signed root ✓')
console.log(JSON.stringify(record, null, 2).split('\n').map((l) => `   ${l}`).join('\n'))

console.log(`\n✅ VERIFIED — ${id.handle} signed exactly this record. Zero trust in our engine.`)

// ── CAR v1 reader (varint-framed blocks) — minimal, no extra deps ────────────
function readVarint(buf, off) {
  let value = 0, shift = 0, i = off
  for (;;) {
    const b = buf[i++]
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [value, i]
}

function parseCar(buf) {
  let [headerLen, off] = readVarint(buf, 0)
  const header = cborDecode(buf.subarray(off, off + headerLen))
  off += headerLen
  const blocks = new Map()
  while (off < buf.length) {
    let blockLen
    ;[blockLen, off] = readVarint(buf, off)
    const end = off + blockLen
    const [cid, payload] = CID.decodeFirst(buf.subarray(off, end))
    blocks.set(cid.toString(), { cid, bytes: payload })
    off = end
  }
  return { roots: header.roots, blocks }
}
