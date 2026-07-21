/**
 * AT Proto service-auth token provider.
 *
 * The agent asks its OWN PDS for a short-lived JWT
 * (com.atproto.server.getServiceAuth): iss = the agent's DID, aud = the
 * engine's DID, signed by the agent's repo key. No IdP, no shared secret —
 * the engine verifies by resolving the DID. This reuses the PDS login the
 * agent already needs; Auth0 was a second, parallel identity path.
 *
 * Tokens default to ~60s TTL, so we cache with a small skew and re-mint.
 */
import { AtpAgent } from '@atproto/api'

/** The engine's DID — the audience every service-auth token is minted for (referee identity). */
const DEFAULT_ENGINE_DID = 'did:plc:xgdzu5egqclsjtiwiv7rkf2k'

export interface TokenProvider {
  get(): Promise<string>
}

export interface ServiceAuthOptions {
  /** the agent's PDS (where it logs in and mints) */
  service: string
  /** the agent's handle — login identifier */
  identifier: string
  /** the agent's PDS/app password */
  password: string
  /** the engine's DID — the token audience */
  audience: string
}

export class ServiceAuthTokenProvider implements TokenProvider {
  private readonly agent: AtpAgent
  private session?: Promise<void>
  private cached?: { token: string; expiresAt: number }

  constructor(private readonly opts: ServiceAuthOptions) {
    this.agent = new AtpAgent({ service: opts.service })
  }

  /** Log in once; the AtpAgent refreshes the session itself thereafter. */
  private ensureSession(): Promise<void> {
    if (!this.session) {
      this.session = this.agent
        .login({ identifier: this.opts.identifier, password: this.opts.password })
        .then(() => undefined)
    }
    return this.session
  }

  private async mint(): Promise<string> {
    await this.ensureSession()
    try {
      const { data } = await this.agent.com.atproto.server.getServiceAuth({ aud: this.opts.audience })
      return data.token
    } catch {
      // Some PDS versions require an lxm binding. The engine verifies with
      // lxm=null (unbound), so any method value it carries is accepted.
      const { data } = await this.agent.com.atproto.server.getServiceAuth({
        aud: this.opts.audience,
        lxm: 'com.atproto.server.getServiceAuth',
      })
      return data.token
    }
  }

  async get(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 10_000) {
      return this.cached.token
    }
    const token = await this.mint()
    // Track the JWT's real exp so the cache follows the PDS's TTL.
    const payloadB64 = token.split('.')[1] ?? ''
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    const exp = typeof claims.exp === 'number' ? claims.exp : Math.floor(Date.now() / 1000) + 60
    this.cached = { token, expiresAt: exp * 1000 }
    return token
  }
}

/** Build a provider for a roster agent from the standard env var layout. */
export function tokenProviderFromEnv(agent: { handle: string; envPrefix: string }): ServiceAuthTokenProvider {
  const password = process.env[`${agent.envPrefix}_PDS_PASSWORD`]
  if (!password) {
    throw new Error(
      `missing env: ${agent.envPrefix}_PDS_PASSWORD (provisioned by scripts/set-agent-pds-passwords.mjs)`,
    )
  }
  return new ServiceAuthTokenProvider({
    service: process.env.PDS_URL ?? 'https://pds.beckitrue.com',
    identifier: agent.handle,
    password,
    audience: process.env.ENGINE_DID ?? DEFAULT_ENGINE_DID,
  })
}
