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

export class Authorizer {
  constructor(private readonly fga: OpenFgaClient) {}

  /** The single question the engine asks before any move takes effect. */
  async check(agentDid: string, permission: Permission, gameId: string): Promise<boolean> {
    const { allowed } = await this.fga.check({
      user: `agent:${agentDid}`,
      relation: permission,
      object: `game:${gameId}`,
    })
    return allowed ?? false
  }

  /** Standing role tuples, written once at game creation. */
  async assignRoles(gameId: string, roles: RoleAssignments): Promise<void> {
    await this.fga.write({
      writes: [
        { user: `agent:${roles.spymasterRed}`, relation: 'spymaster_red', object: `game:${gameId}` },
        { user: `agent:${roles.operativeRed}`, relation: 'operative_red', object: `game:${gameId}` },
        { user: `agent:${roles.spymasterBlue}`, relation: 'spymaster_blue', object: `game:${gameId}` },
        { user: `agent:${roles.operativeBlue}`, relation: 'operative_blue', object: `game:${gameId}` },
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
      deletes.push({ user: `agent:${opts.revoke.clueGiver}`, relation: 'active_clue_giver', object: `game:${gameId}` })
    }
    if (opts.revoke?.guesser) {
      deletes.push({ user: `agent:${opts.revoke.guesser}`, relation: 'active_guesser', object: `game:${gameId}` })
    }
    if (opts.grant.clueGiver) {
      writes.push({ user: `agent:${opts.grant.clueGiver}`, relation: 'active_clue_giver', object: `game:${gameId}` })
    }
    if (opts.grant.guesser) {
      writes.push({ user: `agent:${opts.grant.guesser}`, relation: 'active_guesser', object: `game:${gameId}` })
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
