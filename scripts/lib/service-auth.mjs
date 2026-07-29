/**
 * Mint an AT Proto service-auth JWT — the replacement for the old Auth0
 * client-credentials fetch. The agent logs into its OWN PDS and asks it for a
 * short-lived token (com.atproto.server.getServiceAuth): iss = the agent's
 * DID, aud = the engine's DID, signed by the agent's repo key. The engine
 * verifies it by resolving the DID — no shared secret, no IdP.
 *
 * Works identically for a roster agent on our PDS and a guest on a foreign
 * PDS; only the `pds`/`password` differ.
 */
import { AtpAgent } from '@atproto/api'

/**
 * Log the agent into its own PDS. Returned session can both post to the
 * agent's repo (its speech) and mint service-auth tokens (its authority
 * proof) — one login for both, so a rogue can speak and act in one breath.
 */
export async function loginAgent({ pds, identifier, password }) {
  if (!password) throw new Error(`no PDS password for ${identifier}`)
  const agent = new AtpAgent({ service: pds })
  await agent.login({ identifier, password })
  return agent
}

/** Mint a service-auth JWT (iss = agent DID, aud = engine) from a session. */
export async function tokenFor(agent, audienceDid) {
  try {
    const { data } = await agent.com.atproto.server.getServiceAuth({ aud: audienceDid })
    return data.token
  } catch {
    // Some PDS versions require an lxm binding. The engine verifies with
    // lxm=null (unbound), so whatever method value the token carries is fine.
    const { data } = await agent.com.atproto.server.getServiceAuth({
      aud: audienceDid,
      lxm: 'com.atproto.server.getServiceAuth',
    })
    return data.token
  }
}

export async function mintServiceAuth({ pds, identifier, password, audienceDid }) {
  const agent = await loginAgent({ pds, identifier, password })
  return tokenFor(agent, audienceDid)
}
