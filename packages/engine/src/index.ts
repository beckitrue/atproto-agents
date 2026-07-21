/**
 * Game engine entry point.
 *
 * Env (see infra/.env.example):
 *   ENGINE_DID                            — this engine's DID; the audience
 *     agents mint service-auth tokens for (defaults to the referee DID)
 *   PLC_DIRECTORY_URL                     — optional; point at a local dev PLC
 *     to keep verification off the public plc.directory
 *   FGA_API_URL, FGA_STORE_ID, FGA_MODEL_ID — authorization (auto-populated
 *   from /fga-config/fga.env by fga-init if not set explicitly)
 *   PORT (default 8080)
 */
import Fastify from 'fastify'
import { Authorizer, fgaClientFromEnv } from './fga.js'
import { createVerifier } from './auth.js'
import { GameStore } from './store.js'
import { registerRoutes } from './routes.js'
import { RefereePoster } from './referee.js'

const app = Fastify({ logger: true })

const store = new GameStore()
const authorizer = new Authorizer(fgaClientFromEnv())
const verifyBearer = createVerifier()

// The referee's public voice: gameState records for every event, Bluesky
// mirrors for game start/end and denials. Optional — the engine referees
// fine without a PDS account; it just doesn't publish.
let referee: RefereePoster | undefined
if (process.env.REFEREE_PDS_PASSWORD) {
  referee = new RefereePoster({
    service: process.env.PDS_URL ?? `https://pds.${process.env.DOMAIN}`,
    identifier: process.env.REFEREE_HANDLE ?? `referee.${process.env.DOMAIN}`,
    password: process.env.REFEREE_PDS_PASSWORD,
    log: (m) => app.log.info(m),
  })
  try {
    await referee.login()
    app.log.info('referee publishing enabled')
  } catch (err) {
    app.log.error(`referee login failed — publishing disabled: ${(err as Error).message}`)
    referee = undefined
  }
} else {
  app.log.info('REFEREE_PDS_PASSWORD not set — referee publishing disabled')
}

registerRoutes(app, {
  store,
  authorizer,
  verifyBearer,
  ...(referee ? { onEvent: (game) => referee!.publish(game) } : {}),
})

const port = Number(process.env.PORT ?? 8080)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`game engine listening on :${port}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
