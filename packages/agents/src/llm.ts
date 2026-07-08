/**
 * The Claude-powered brain. One API call per move, constrained to a JSON
 * schema via structured outputs — no fragile text parsing. Every decision
 * carries `reasoning`, which the Bluesky mirror posts will surface so the
 * audience can follow the agents' thinking.
 *
 * Any API failure or invalid decision throws; the runner composes this with
 * ScriptedBrain via withFallback(), so the demo survives a dead API key.
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  Brain,
  ClueDecision,
  GuessDecision,
  OperativeView,
  SpymasterView,
} from './brain.js'

const CLUE_SCHEMA = {
  type: 'object',
  properties: {
    word: {
      type: 'string',
      description: 'The clue: a single English word, NOT any word on the board',
    },
    count: {
      type: 'integer',
      enum: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      description: 'How many board words this clue points to',
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of the connection, for the audience (do not reveal card types)',
    },
  },
  required: ['word', 'count', 'reasoning'],
  additionalProperties: false,
} as const

const GUESS_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['guess', 'pass'] },
    word: {
      type: 'string',
      description: 'The unrevealed board word to guess. Empty string when passing.',
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of the choice, for the audience',
    },
  },
  required: ['action', 'word', 'reasoning'],
  additionalProperties: false,
} as const

const SPYMASTER_SYSTEM = `You are a Codenames spymaster. You can see the key card — which words belong to your team, which to the enemy, which are bystanders, and which single word is the assassin.

Give the best one-word clue for your operative:
- The clue must be a single English word that is NOT on the board and not a form of a board word.
- The count is how many of YOUR unrevealed words it points to.
- Your operative will avoid nothing on their own — a clue that also fits the assassin or enemy words is how games are lost. Prefer a safe 2-word connection over a risky 3.
- Your reasoning will be shown publicly; explain the connection without revealing which words are which color.`

const OPERATIVE_SYSTEM = `You are a Codenames operative. Your spymaster gave a clue; you see only the public board (revealed cards show their color, unrevealed cards do not).

Decide whether to guess an unrevealed word or pass:
- Guess the unrevealed word that best matches the clue.
- One wrong guess ends your turn; revealing the assassin loses the game instantly. If nothing fits the clue well, pass.
- You may guess up to count+1 times per clue; after the count is satisfied, pass unless you are confident about a leftover word from an earlier clue.
- Your reasoning will be shown publicly.`

export interface LlmBrainOptions {
  /** Injectable for tests. Defaults to a client using ANTHROPIC_API_KEY. */
  client?: Anthropic
  model?: string
}

export class LlmBrain implements Brain {
  readonly kind = 'llm'
  private readonly client: Anthropic
  private readonly model: string

  constructor(opts: LlmBrainOptions = {}) {
    this.client = opts.client ?? new Anthropic()
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
  }

  private async decide<T>(system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    })
    if (response.stop_reason === 'refusal') {
      throw new Error('model refused the request')
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('response truncated at max_tokens')
    }
    const text = response.content.find((b) => b.type === 'text')
    if (!text) throw new Error('no text block in response')
    return JSON.parse(text.text) as T
  }

  async giveClue(view: SpymasterView): Promise<ClueDecision> {
    const fmt = (type: string) =>
      view.key
        .filter((c) => c.cardType === type && !c.revealed)
        .map((c) => c.word)
        .join(', ') || '(none)'
    const revealed = view.key.filter((c) => c.revealed).map((c) => `${c.word} (${c.cardType})`).join(', ') || '(none)'
    const enemy: string = view.team === 'red' ? 'blue' : 'red'

    const prompt = `You are the ${view.team} spymaster.

YOUR unrevealed words: ${fmt(view.team)}
Enemy (${enemy}) unrevealed words: ${fmt(enemy)}
Bystander unrevealed words: ${fmt('bystander')}
THE ASSASSIN: ${fmt('assassin')}
Already revealed: ${revealed}

Give your clue.`

    const clue = await this.decide<ClueDecision>(SPYMASTER_SYSTEM, prompt, CLUE_SCHEMA)
    const word = clue.word.trim().toUpperCase()
    if (!/^[A-Z][A-Z-]*$/.test(word)) {
      throw new Error(`invalid clue word from model: "${clue.word}"`)
    }
    if (view.key.some((c) => !c.revealed && c.word === word)) {
      throw new Error(`model clued a board word: "${word}"`)
    }
    return { ...clue, word }
  }

  async guess(view: OperativeView): Promise<GuessDecision> {
    const unrevealed = view.board.filter((c) => !c.revealed).map((c) => c.word)
    const revealed =
      view.board.filter((c) => c.revealed).map((c) => `${c.word} (${c.cardType})`).join(', ') || '(none)'

    const prompt = `You are the ${view.team} operative.

Clue: "${view.clue.word}" for ${view.clue.count}
Guesses you have already made against this clue: ${view.guessesMade}

Unrevealed words: ${unrevealed.join(', ')}
Revealed so far: ${revealed}

Guess or pass?`

    const decision = await this.decide<GuessDecision>(OPERATIVE_SYSTEM, prompt, GUESS_SCHEMA)
    if (decision.action === 'guess') {
      const word = (decision.word ?? '').trim().toUpperCase()
      if (!unrevealed.includes(word)) {
        throw new Error(`model guessed a word not on the unrevealed board: "${decision.word}"`)
      }
      return { ...decision, word }
    }
    return decision
  }
}
