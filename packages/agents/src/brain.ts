/**
 * The decision layer. A Brain answers exactly two questions — "what clue?"
 * and "what guess?" — and knows nothing about HTTP, tokens, or AT Proto.
 *
 * Two implementations:
 *   - ScriptedBrain: deterministic, seeded, zero dependencies. The demo
 *     fallback — if the LLM API is unreachable mid-talk, the game goes on.
 *   - LlmBrain (llm.ts): Claude decides, with stated reasoning.
 *
 * withFallback() composes them: any primary failure silently degrades to
 * the fallback for that move.
 */
import type { Card, CardType, ClueRef, Team } from '@atproto-agents/lexicon'

/** Full-knowledge card, as returned by the engine's spymaster-only /key. */
export interface KeyCard {
  word: string
  cardType: CardType
  revealed: boolean
}

export interface SpymasterView {
  team: Team
  /** The key card — every word with its true type. */
  key: KeyCard[]
}

export interface OperativeView {
  team: Team
  /** Public board — card types visible only where revealed. */
  board: Card[]
  clue: ClueRef
  /** Guesses this agent has already made against the current clue. */
  guessesMade: number
}

export interface ClueDecision {
  word: string
  count: number
  reasoning: string
}

export interface GuessDecision {
  action: 'guess' | 'pass'
  /** Required when action is 'guess'. */
  word?: string
  reasoning: string
}

export interface Brain {
  readonly kind: string
  giveClue(view: SpymasterView): Promise<ClueDecision>
  guess(view: OperativeView): Promise<GuessDecision>
}

/** Same PRNG as the engine's board dealing — scripted demos replay exactly. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Neutral clue words, none of which appear in the engine's board word list. */
const FALLBACK_CLUES = [
  'NEBULA', 'QUARTZ', 'TANGO', 'ORBIT', 'SAFARI', 'GLYPH', 'PRISM', 'ECHO',
  'BREEZE', 'COBALT', 'MOSAIC', 'RIDDLE', 'VECTOR', 'AMBER', 'FJORD', 'ZENITH',
]

/**
 * Deterministic fallback player. Not smart, but always legal:
 * clues an off-board word for min(2, remaining), guesses one random
 * unrevealed card per clue, then passes.
 */
export class ScriptedBrain implements Brain {
  readonly kind = 'scripted'
  private readonly rng: () => number
  private clueIndex = 0

  constructor(seed = 1) {
    this.rng = seededRng(seed)
  }

  async giveClue(view: SpymasterView): Promise<ClueDecision> {
    const boardWords = new Set(view.key.map((c) => c.word))
    let word = FALLBACK_CLUES[this.clueIndex % FALLBACK_CLUES.length]!
    while (boardWords.has(word)) {
      this.clueIndex++
      word = FALLBACK_CLUES[this.clueIndex % FALLBACK_CLUES.length]!
    }
    this.clueIndex++
    const remaining = view.key.filter((c) => c.cardType === view.team && !c.revealed).length
    return {
      word,
      count: Math.max(1, Math.min(2, remaining)),
      reasoning: 'scripted fallback: neutral clue to keep the game moving',
    }
  }

  async guess(view: OperativeView): Promise<GuessDecision> {
    if (view.guessesMade >= 1) {
      return { action: 'pass', reasoning: 'scripted fallback: one guess per clue, then pass' }
    }
    const unrevealed = view.board.filter((c) => !c.revealed)
    const pick = unrevealed[Math.floor(this.rng() * unrevealed.length)]!
    return {
      action: 'guess',
      word: pick.word,
      reasoning: 'scripted fallback: deterministic pick from unrevealed cards',
    }
  }
}

/** Try the primary brain; on ANY failure, use the fallback for that move. */
export function withFallback(primary: Brain, fallback: Brain, onFallback?: (err: Error) => void): Brain {
  const rescue = async <T>(attempt: () => Promise<T>, recover: () => Promise<T>): Promise<T> => {
    try {
      return await attempt()
    } catch (err) {
      onFallback?.(err as Error)
      return recover()
    }
  }
  return {
    kind: `${primary.kind}+fallback:${fallback.kind}`,
    giveClue: (view) => rescue(() => primary.giveClue(view), () => fallback.giveClue(view)),
    guess: (view) => rescue(() => primary.guess(view), () => fallback.guess(view)),
  }
}
