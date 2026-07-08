/**
 * Auth0 FGA client wrapper — the authorization layer.
 *
 * Turn-gating works by WRITING and DELETING tuples on turn transitions
 * (rather than FGA conditions): explicit tuples are visible in the FGA
 * dashboard, so the audience literally watches authority appear and
 * disappear as turns change.
 *
 * Model (infra/fga/model.fga):
 *   type agent
 *   type game
 *     relations
 *       define spymaster_red: [agent]      # standing role assignments
 *       define operative_red: [agent]
 *       define spymaster_blue: [agent]
 *       define operative_blue: [agent]
 *       define active_clue_giver: [agent]  # ephemeral, per-turn
 *       define active_guesser: [agent]
 *       define can_give_clue: active_clue_giver
 *       define can_guess: active_guesser
 *       define can_view_key: spymaster_red or spymaster_blue
 */
import { CredentialsMethod, OpenFgaClient } from '@openfga/sdk'
import type { Team } from '@atproto-agents/lexicon'

export type Permission = 'can_give_clue' | 'can_guess' | 'can_view_key'

/**
 * FGA object/user IDs may not contain colons, so DIDs are encoded with
 * underscores: did:plc:xyz → did_plc_xyz. Unambiguous for did:plc (base32
 * method-specific ids never contain underscores).
 */
export function didToFgaUser(did: string): string {
  return `agent:${did.replaceAll(':', '_')}`
}

export interface RoleAssignments {
  spymasterRed: string // agent DIDs
  operativeRed: string
  spymasterBlue: string
  operativeBlue: string
}

export function fgaClientFromEnv(): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl: process.env.FGA_API_URL ?? 'https://api.us1.fga.dev',
    storeId: process.env.FGA_STORE_ID!,
    authorizationModelId: process.env.FGA_MODEL_ID, // optional pin
    credentials: {
      method: CredentialsMethod.ClientCredentials,
      config: {
        apiTokenIssuer: process.env.FGA_API_TOKEN_ISSUER ?? 'auth.fga.dev',
        apiAudience: process.env.FGA_API_AUDIENCE ?? 'https://api.us1.fga.dev/',
        clientId: process.env.FGA_CLIENT_ID!,
        clientSecret: process.env.FGA_CLIENT_SECRET!,
      },
    },
  })
}

/** The operations the engine needs from the authorization layer. */
export interface AuthorizerApi {
  check(agentDid: string, permission: Permission, gameId: string): Promise<boolean>
  assignRoles(gameId: string, roles: RoleAssignments): Promise<void>
  transitionTurn(
    gameId: string,
    opts: {
      revoke?: { clueGiver?: string; guesser?: string }
      grant: { clueGiver?: string; guesser?: string }
    },
  ): Promise<void>
}

export class Authorizer implements AuthorizerApi {
  constructor(private readonly fga: OpenFgaClient) {}

  /** The single question the engine asks before any move takes effect. */
  async check(agentDid: string, permission: Permission, gameId: string): Promise<boolean> {
    const { allowed } = await this.fga.check({
      user: didToFgaUser(agentDid),
      relation: permission,
      object: `game:${gameId}`,
    })
    return allowed ?? false
  }

  /** Standing role tuples, written once at game creation. */
  async assignRoles(gameId: string, roles: RoleAssignments): Promise<void> {
    await this.fga.write({
      writes: [
        { user: didToFgaUser(roles.spymasterRed), relation: 'spymaster_red', object: `game:${gameId}` },
        { user: didToFgaUser(roles.operativeRed), relation: 'operative_red', object: `game:${gameId}` },
        { user: didToFgaUser(roles.spymasterBlue), relation: 'spymaster_blue', object: `game:${gameId}` },
        { user: didToFgaUser(roles.operativeBlue), relation: 'operative_blue', object: `game:${gameId}` },
      ],
    })
  }

  /**
   * Turn transition: revoke the previous turn's ephemeral tuples, grant the
   * next turn's. This is the on-stage moment — authority moving between agents.
   */
  async transitionTurn(
    gameId: string,
    opts: {
      revoke?: { clueGiver?: string; guesser?: string }
      grant: { clueGiver?: string; guesser?: string }
    },
  ): Promise<void> {
    const deletes = []
    const writes = []
    if (opts.revoke?.clueGiver) {
      deletes.push({ user: didToFgaUser(opts.revoke.clueGiver), relation: 'active_clue_giver', object: `game:${gameId}` })
    }
    if (opts.revoke?.guesser) {
      deletes.push({ user: didToFgaUser(opts.revoke.guesser), relation: 'active_guesser', object: `game:${gameId}` })
    }
    if (opts.grant.clueGiver) {
      writes.push({ user: didToFgaUser(opts.grant.clueGiver), relation: 'active_clue_giver', object: `game:${gameId}` })
    }
    if (opts.grant.guesser) {
      writes.push({ user: didToFgaUser(opts.grant.guesser), relation: 'active_guesser', object: `game:${gameId}` })
    }
    await this.fga.write({
      ...(deletes.length ? { deletes } : {}),
      ...(writes.length ? { writes } : {}),
    })
  }
}

/** Which DIDs hold which roles — used to compute turn transitions. */
export function turnHolders(roles: RoleAssignments, turn: Team): { clueGiver: string; guesser: string } {
  return turn === 'red'
    ? { clueGiver: roles.spymasterRed, guesser: roles.operativeRed }
    : { clueGiver: roles.spymasterBlue, guesser: roles.operativeBlue }
}
