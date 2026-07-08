/**
 * Agent roster. Each agent has:
 *  - an AT Proto identity (DID + handle) on our PDS   — who it IS
 *  - an Auth0 M2M application (client id/secret)      — how it AUTHENTICATES
 *  - a role in the game                               — what FGA AUTHORIZES
 *
 * Secrets come from env; this file is the public shape.
 */
import type { Team } from '@atproto-agents/lexicon'

export type Role = 'spymaster' | 'operative'

export interface AgentConfig {
  name: string
  handle: string
  team: Team
  role: Role
  /** env var prefix, e.g. RED_SPYMASTER → RED_SPYMASTER_AUTH0_CLIENT_ID etc. */
  envPrefix: string
}

export const ROSTER: AgentConfig[] = [
  { name: 'red-spymaster', handle: 'red-spymaster.beckitrue.com', team: 'red', role: 'spymaster', envPrefix: 'RED_SPYMASTER' },
  { name: 'red-operative', handle: 'red-operative.beckitrue.com', team: 'red', role: 'operative', envPrefix: 'RED_OPERATIVE' },
  { name: 'blue-spymaster', handle: 'blue-spymaster.beckitrue.com', team: 'blue', role: 'spymaster', envPrefix: 'BLUE_SPYMASTER' },
  { name: 'blue-operative', handle: 'blue-operative.beckitrue.com', team: 'blue', role: 'operative', envPrefix: 'BLUE_OPERATIVE' },
]

export const GAME_ENGINE_URL = process.env.GAME_ENGINE_URL ?? 'https://game.beckitrue.com'
export const PDS_URL = process.env.PDS_URL ?? 'https://pds.beckitrue.com'
