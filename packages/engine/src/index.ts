/**
 * Game engine entry point.
 *
 * Env (see infra/.env.example):
 *   AUTH0_DOMAIN, AUTH0_AUDIENCE          — token verification
 *   FGA_STORE_ID, FGA_CLIENT_ID, FGA_CLIENT_SECRET (+ optional FGA_API_URL,
 *   FGA_MODEL_ID, FGA_API_TOKEN_ISSUER, FGA_API_AUDIENCE) — authorization
 *   PORT (default 8080)
 */
import Fastify from 'fastify'
import { Authorizer, fgaClientFromEnv } from './fga.js'
import { createVerifier } from './auth.js'
import { GameStore } from './store.js'
import { registerRoutes } from './routes.js'

const app = Fastify({ logger: true })

const store = new GameStore()
const authorizer = new Authorizer(fgaClientFromEnv())
const verifyBearer = createVerifier()

registerRoutes(app, {
  store,
  authorizer,
  verifyBearer,
  // TODO(week 2): onEvent → referee posts gameState records + Bluesky mirror
})

const port = Number(process.env.PORT ?? 8080)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`game engine listening on :${port}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
