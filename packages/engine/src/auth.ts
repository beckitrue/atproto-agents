/**
 * AT Proto service-auth verification.
 *
 * Each agent asks its OWN PDS for a short-lived JWT via
 * com.atproto.server.getServiceAuth: iss = the agent's DID, aud = this
 * engine's DID, signed by the agent's repo key. We verify with zero shared
 * secrets — resolve the issuer DID to its signing key (through the PLC
 * directory) and check the signature. Authentication answers "who is this?";
 * FGA answers "may they do this?".
 *
 * No IdP: the DID *is* the identity. A token minted on any PDS in the network
 * — including a guest on a foreign PDS — verifies the exact same way.
 */
import { IdResolver } from '@atproto/identity'
import { verifyJwt } from '@atproto/xrpc-server'

/** The engine's own AT Proto identity (the referee DID) — the audience agents mint for. */
const DEFAULT_ENGINE_DID = 'did:plc:xgdzu5egqclsjtiwiv7rkf2k'

export interface AgentIdentity {
  /** AT Proto DID of the caller — the verified token issuer (iss). */
  did: string
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export function createVerifier(opts?: { engineDid?: string; plcUrl?: string }) {
  const engineDid = opts?.engineDid ?? process.env.ENGINE_DID ?? DEFAULT_ENGINE_DID
  // Point at a self-contained dev PLC to keep local runs off the public
  // plc.directory; unset → @atproto/identity defaults to plc.directory.
  const plcUrl = opts?.plcUrl ?? process.env.PLC_DIRECTORY_URL
  const idr = new IdResolver(plcUrl ? { plcUrl } : {})
  const getSigningKey = (iss: string, forceRefresh: boolean) =>
    idr.did.resolveAtprotoKey(iss, forceRefresh)

  return async function verifyBearer(authorizationHeader: string | undefined): Promise<AgentIdentity> {
    if (!authorizationHeader?.startsWith('Bearer ')) {
      throw new AuthError('missing bearer token')
    }
    const token = authorizationHeader.slice('Bearer '.length)
    try {
      // ownDid enforces the aud binding; lxm=null — this is a REST engine, the
      // token isn't bound to a lexicon method.
      const payload = await verifyJwt(token, engineDid, null, getSigningKey)
      return { did: payload.iss }
    } catch (err) {
      throw new AuthError(`token verification failed: ${(err as Error).message}`)
    }
  }
}
