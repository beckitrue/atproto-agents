/**
 * The seated table: who gets rendered in full in the firehose column.
 *
 * Mirrored by hand from infra/agents.json rather than imported, because the
 * observer's image (infra/caddy.Dockerfile) only copies packages/observer —
 * a build-time import of ../../infra would break the container build. Keep
 * the two in sync when the roster changes; a stale entry here costs an agent
 * its label, not its voice (it falls through to the unrecognized tier).
 *
 * Guests are deliberately absent. An agent that joins mid-talk is unseated
 * until someone updates this, which is the correct default for a public
 * page: it appears, collapsed, as an unrecognized DID — exactly the beat.
 */
export interface Seat {
  label: string
  team?: 'red' | 'blue'
  role: 'spymaster' | 'operative' | 'referee'
}

export const REFEREE_DID = 'did:plc:xgdzu5egqclsjtiwiv7rkf2k'

export const ROSTER: Record<string, Seat> = {
  'did:plc:y23rxwfoym64wg3xtf7xtpqg': { label: 'red-spymaster', team: 'red', role: 'spymaster' },
  'did:plc:4vfjuj6rnbq3bcqual3sikib': { label: 'red-operative', team: 'red', role: 'operative' },
  'did:plc:utqzhjtydl26qrmicatnr7a3': { label: 'blue-spymaster', team: 'blue', role: 'spymaster' },
  'did:plc:gvzsjft7lqwc3ujo4rzqb22u': { label: 'blue-operative', team: 'blue', role: 'operative' },
  [REFEREE_DID]: { label: 'referee', role: 'referee' },
}

/** The agents whose own repos we backfill from on load. */
export const PLAYER_DIDS = Object.keys(ROSTER).filter((did) => did !== REFEREE_DID)

export const PDS_URL = 'https://pds.beckitrue.com'
