/**
 * Auth0 authentication — verifies M2M client-credentials tokens.
 *
 * Each agent is an Auth0 Machine-to-Machine application. The agent's AT Proto
 * DID travels as a custom claim on the access token, set by an Auth0 Action
 * on the client-credentials exchange. Authentication answers "who is this?";
 * FGA answers "may they do this?".
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'

/** Custom claim carrying the agent's AT Proto DID */
export const DID_CLAIM = 'https://beckitrue.com/atproto_did'

export interface AgentIdentity {
  /** Auth0 client ID (token sub) */
  sub: string
  /** AT Proto DID from the custom claim */
  did: string
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export function createVerifier(opts?: { domain?: string; audience?: string }) {
  const domain = opts?.domain ?? process.env.AUTH0_DOMAIN!
  const audience = opts?.audience ?? process.env.AUTH0_AUDIENCE ?? 'https://game.beckitrue.com'
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))

  return async function verifyBearer(authorizationHeader: string | undefined): Promise<AgentIdentity> {
    if (!authorizationHeader?.startsWith('Bearer ')) {
      throw new AuthError('missing bearer token')
    }
    const token = authorizationHeader.slice('Bearer '.length)
    let payload
    try {
      ;({ payload } = await jwtVerify(token, jwks, {
        issuer: `https://${domain}/`,
        audience,
      }))
    } catch (err) {
      throw new AuthError(`token verification failed: ${(err as Error).message}`)
    }
    const did = payload[DID_CLAIM]
    if (typeof did !== 'string' || !did.startsWith('did:')) {
      throw new AuthError(`token missing ${DID_CLAIM} claim`)
    }
    return { sub: payload.sub as string, did }
  }
}
