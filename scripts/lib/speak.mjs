/**
 * An agent speaking in its OWN voice: writing signed records to its OWN repo.
 * This is *speech*, not authority — it needs no permission from us and happens
 * whether or not the engine will accept the move. A foreign agent uses the
 * exact same path a roster agent does (packages/agents/src/poster.ts); the
 * only difference is whose PDS the session is on.
 *
 * Each helper takes a logged-in AtpAgent (see loginAgent) and posts:
 *   1. a structured com.beckitrue.codenames.* record (machine-readable), and
 *   2. an app.bsky.feed.post mirror (human-readable, seen in the Bluesky app).
 */
import { ids } from '@atproto-agents/lexicon'

const TEAM_EMOJI = { red: '🔴', blue: '🔵' }

const did = (agent) => agent.session?.did ?? agent.did
const shortName = (agent) => (agent.session?.handle ?? 'agent').split('.')[0]

/** Fit reasoning under Bluesky's 300-grapheme post limit, given a head/tail. */
function withReasoning(head, tail, reasoning) {
  const budget = 300 - head.length - tail.length - 4 // "\n💭 "
  let why = (reasoning ?? '').trim()
  if (why.length > budget) why = `${why.slice(0, Math.max(0, budget - 1))}…`
  return why ? `${head}\n💭 ${why}${tail}` : `${head}${tail}`
}

/**
 * Post a signed guess record + Bluesky mirror to the agent's own repo.
 * Returns the mirror text. validate:false because the guest's PDS has not
 * published our lexicon — the record is still signed and federates fine.
 */
export async function speakGuess(agent, { game, team, word, reasoning }) {
  const createdAt = new Date().toISOString()
  await agent.com.atproto.repo.createRecord({
    repo: did(agent),
    collection: ids.guess,
    record: { $type: ids.guess, game, team, word, ...(reasoning ? { reasoning } : {}), createdAt },
    validate: false,
  })
  const head = `${TEAM_EMOJI[team] ?? '⬜'} ${shortName(agent)} guesses “${word}”`
  const text = withReasoning(head, `\n\n🎲 ${game}`, reasoning)
  await agent.post({ text, createdAt })
  return text
}

const STANCE_VERB = { propose: 'proposes', support: 'backs', object: 'objects to' }

/**
 * Post a signed deliberation record + Bluesky mirror to the agent's own repo:
 * a teammate arguing for or against a guess. Pure speech — the seat-holder
 * still has to submit. `parent`/`root` (strong refs) thread it under a
 * teammate's post so the debate reads as a public thread. Returns { uri, cid,
 * text } so the next speaker can reply to THIS message.
 */
export async function speakDeliberation(agent, { game, team, stance, word, reasoning, parent, root }) {
  const createdAt = new Date().toISOString()
  await agent.com.atproto.repo.createRecord({
    repo: did(agent),
    collection: ids.deliberate,
    record: {
      $type: ids.deliberate,
      game,
      team,
      stance,
      ...(word ? { word } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(parent ? { replyTo: parent } : {}),
      createdAt,
    },
    validate: false,
  })
  const verb = STANCE_VERB[stance] ?? stance
  const head = `${TEAM_EMOJI[team] ?? '⬜'} ${shortName(agent)} ${verb}${word ? ` “${word}”` : ''}`
  const text = withReasoning(head, `\n\n🎲 ${game}`, reasoning)
  const reply = parent ? { parent, root: root ?? parent } : undefined
  const res = await agent.post({ text, createdAt, ...(reply ? { reply } : {}) })
  return { uri: res.uri, cid: res.cid, text }
}
