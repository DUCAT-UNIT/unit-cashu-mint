import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { testConnection } from '../../src/database/db.js'
import type { FastifyInstance } from 'fastify'

describe('App Factory', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    await testConnection()
  })

  afterAll(async () => {
    if (server) {
      await server.close()
    }
  })

  it('should create server instance', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    expect(server).toBeDefined()
    expect(server.diContainer).toBeDefined()
  })

  it('should have registered routes', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    const routes = server.printRoutes()
    expect(routes).toContain('health')
    expect(routes).toContain('info')
    expect(routes).toContain('keys')
    expect(routes).toContain('int/') // mint
    expect(routes).toContain('swap')
    expect(routes).toContain('elt/') // melt
  })

  it('should respond to health check', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    const response = await server.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.1.0')
  })

  it('should respond to info endpoint', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    const response = await server.inject({
      method: 'GET',
      url: '/v1/info',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.name).toBeDefined()
    expect(body.version).toBe('0.1.0')
    expect(body.nuts).toBeDefined()
    expect(body.nuts['4']).toBeDefined()
    expect(body.nuts['5']).toBeDefined()
  })

  it('should have CORS enabled', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    })

    expect(response.headers['access-control-allow-origin']).toBeDefined()
  })

  it('should have error handler', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    // Trigger 404
    const response = await server.inject({
      method: 'GET',
      url: '/nonexistent',
    })

    expect(response.statusCode).toBe(404)
  })

  it('should handle MintError in error handler', async () => {
    const { createServer } = await import('../../src/app.js')
    const { QuoteNotFoundError } = await import('../../src/utils/errors.js')
    server = await createServer()

    // Register a route that throws a MintError
    server.get('/test-error', async () => {
      throw new QuoteNotFoundError('test123')
    })

    const response = await server.inject({
      method: 'GET',
      url: '/test-error',
    })

    expect(response.statusCode).toBe(400)
    const body = JSON.parse(response.body)
    expect(body.error).toBe('Quote not found')
    expect(body.code).toBe(10000)
    expect(body.detail).toBe('quote=test123')
  })

  it('should handle generic errors in error handler', async () => {
    const { createServer } = await import('../../src/app.js')
    server = await createServer()

    // Register a route that throws a generic error
    server.get('/test-generic-error', async () => {
      throw new Error('Something went wrong')
    })

    const response = await server.inject({
      method: 'GET',
      url: '/test-generic-error',
    })

    expect(response.statusCode).toBe(500)
    const body = JSON.parse(response.body)
    expect(body.error).toBe('Internal server error')
  })
})
