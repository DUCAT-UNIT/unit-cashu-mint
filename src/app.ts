import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { env } from './config/env.js'
import { logger } from './utils/logger.js'
import { initializeContainer, DIContainer } from './di/container.js'
import { swapRoutes } from './api/routes/swap.js'
import { mintRoutes } from './api/routes/mint.js'
import { meltRoutes } from './api/routes/melt.js'
import { keysRoutes } from './api/routes/keys.js'

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
export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: logger,
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
  })

  // Initialize dependency injection container
  const container = initializeContainer()
  server.decorate('diContainer', container)

  // Register plugins
  await server.register(cors, {
    origin: true, // TODO: Configure for production
  })

  await server.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
  })

  // Register API routes
  await server.register(swapRoutes)
  await server.register(mintRoutes)
  await server.register(meltRoutes)
  await server.register(keysRoutes)

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
    return {
      name: env.MINT_NAME,
      pubkey: env.MINT_PUBKEY,
      version: '0.1.0',
      description: env.MINT_DESCRIPTION,
      contact: [
        env.MINT_CONTACT_EMAIL && { method: 'email', info: env.MINT_CONTACT_EMAIL },
        env.MINT_CONTACT_NOSTR && { method: 'nostr', info: env.MINT_CONTACT_NOSTR },
      ].filter(Boolean),
      motd: 'Welcome to Ducat UNIT Mint!',
      nuts: {
        '4': {
          methods: [
            {
              method: 'unit',
              unit: 'sat',
              min_amount: env.MIN_MINT_AMOUNT,
              max_amount: env.MAX_MINT_AMOUNT,
            },
          ],
          disabled: false,
        },
        '5': {
          methods: [
            {
              method: 'unit',
              unit: 'sat',
              min_amount: env.MIN_MELT_AMOUNT,
              max_amount: env.MAX_MELT_AMOUNT,
            },
          ],
          disabled: false,
        },
        '7': { supported: true },
        '8': { supported: true },
        '12': { supported: true },
      },
    }
  })

  // Error handler
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
        detail: mintError.detail,
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

  return server
}
