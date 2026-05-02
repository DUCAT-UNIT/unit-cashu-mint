import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { env } from './config/env.js'
import { logger } from './utils/logger.js'
import { initializeContainer, DIContainer } from './di/container.js'
import { swapRoutes } from './api/routes/swap.js'
import { mintRoutes } from './api/routes/mint.js'
import { meltRoutes } from './api/routes/melt.js'
import { keysRoutes } from './api/routes/keys.js'
import { checkStateRoutes } from './api/routes/checkstate.js'
import { dashboardRoutes } from './api/routes/dashboard.js'
import { restoreRoutes } from './api/routes/restore.js'
import { wsRoutes } from './api/routes/ws.js'
import { buildMintInfo } from './mint-info.js'

// Augment FastifyInstance with our DI container
declare module 'fastify' {
  interface FastifyInstance {
    diContainer: DIContainer
  }
}

/**
 * Create and configure the Fastify server instance
 * This function is exported for testing purposes
 */
export async function createServer() {
  const server = Fastify({
    logger: logger,
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
  })

  // Initialize dependency injection container
  const container = initializeContainer()
  server.decorate('diContainer', container)

  const corsOrigin = env.CORS_ORIGINS_ARRAY?.includes('*') ? true : (env.CORS_ORIGINS_ARRAY ?? true)

  // Register plugins
  await server.register(cors, {
    origin: corsOrigin,
    credentials: true,
  })

  await server.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
  })

  await server.register(websocket)

  // Error handler. Register this before route plugins so plugin-scoped routes
  // inherit Cashu/NUT-00 error formatting.
  server.setErrorHandler((error, request, reply) => {
    logger.error(
      {
        err: error,
        reqId: request.id,
        method: request.method,
        url: request.url,
        stack: error.stack,
      },
      'Request error'
    )

    // Handle MintError instances
    if (error.name === 'MintError') {
      const mintError = error as unknown as { code?: number; detail?: string }
      return reply.status(400).send({
        error: error.message,
        code: mintError.code,
        detail: mintError.detail ?? error.message,
      })
    }

    // Default error
    const response: { error: string; detail?: string; stack?: string } = {
      error: error.message || 'Internal server error',
    }

    if (env.NODE_ENV === 'development') {
      response.detail = error.message
      response.stack = error.stack
    }

    return reply.status(500).send(response)
  })

  // Register API routes
  await server.register(swapRoutes)
  await server.register(mintRoutes)
  await server.register(meltRoutes)
  await server.register(keysRoutes)
  await server.register(checkStateRoutes)
  await server.register(restoreRoutes)
  await server.register(wsRoutes)
  await server.register(dashboardRoutes)

  // Some wallets append API paths to the pasted mint URL. If a user pastes
  // /v1/info instead of the mint base URL, keep the request on the real API.
  server.all('/v1/info/v1/*', async (request, reply) => {
    const target = request.url.replace(/^\/v1\/info(?=\/v1(?:\/|$))/, '')
    return reply.redirect(target, 308)
  })

  // Health check
  server.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: Date.now(),
      version: '0.1.0',
    }
  })

  // API routes
  server.get('/v1/info', async () => {
    return buildMintInfo(env)
  })

  return server
}
