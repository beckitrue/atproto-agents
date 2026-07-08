/**
 * Auth0 M2M token provider — client-credentials grant, cached until
 * shortly before expiry. The token carries the agent's AT Proto DID as a
 * custom claim (stamped by the tenant's credentials-exchange Action).
 */

export interface TokenProvider {
  get(): Promise<string>
}

export interface Auth0Options {
  domain: string
  clientId: string
  clientSecret: string
  audience: string
}

export class Auth0TokenProvider implements TokenProvider {
  private cached?: { token: string; expiresAt: number }

  constructor(private readonly opts: Auth0Options) {}

  async get(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) {
      return this.cached.token
    }
    const res = await fetch(`https://${this.opts.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        audience: this.opts.audience,
      }),
    })
    if (!res.ok) {
      throw new Error(`Auth0 token request failed: ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { access_token: string; expires_in: number }
    this.cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return body.access_token
  }
}

/** Build a provider for a roster agent from the standard env var layout. */
export function tokenProviderFromEnv(envPrefix: string): Auth0TokenProvider {
  const domain = process.env.AUTH0_DOMAIN
  const clientId = process.env[`${envPrefix}_AUTH0_CLIENT_ID`]
  const clientSecret = process.env[`${envPrefix}_AUTH0_CLIENT_SECRET`]
  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      `missing env: need AUTH0_DOMAIN, ${envPrefix}_AUTH0_CLIENT_ID, ${envPrefix}_AUTH0_CLIENT_SECRET`,
    )
  }
  return new Auth0TokenProvider({
    domain,
    clientId,
    clientSecret,
    audience: process.env.AUTH0_AUDIENCE ?? 'https://game.beckitrue.com',
  })
}
