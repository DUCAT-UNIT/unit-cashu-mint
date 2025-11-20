import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { testConnection } from '../../src/database/db.js'
import type { FastifyInstance } from 'fastify'
import { createServer } from '../../src/app.js'

describe('API Routes Integration', () => {
  let server: FastifyInstance
  let keysetId: string
  const UNIT = 'unit' // UNIT tokens, not sats!
  const RUNE_ID = '840000:3'

  beforeAll(async () => {
    await testConnection()
    server = await createServer()

    // Generate a test keyset
    const keyManager = server.diContainer.resolve('keyManager')
    const keyset = await keyManager.generateKeyset(RUNE_ID, UNIT)
    keysetId = keyset.id
  })

  afterAll(async () => {
    await server.close()
  })

  describe('Keys Routes', () => {
    it('GET /v1/keys should return active keysets', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/keys',
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.keysets).toBeDefined()
      expect(Array.isArray(body.keysets)).toBe(true)
      expect(body.keysets.length).toBeGreaterThan(0)
    })

    it('GET /v1/keys/:keyset_id should return specific keyset', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/v1/keys/${keysetId}`,
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body).toBeDefined()
    })

    it('GET /v1/keysets should return keyset list', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/keysets',
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.keysets).toBeDefined()
      expect(Array.isArray(body.keysets)).toBe(true)
    })
  })

  describe('Mint Routes', () => {
    let quoteId: string

    it('POST /v1/mint/quote/runes should create mint quote', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/quote/runes',
        payload: {
          amount: 1000,
          unit: UNIT,
          rune_id: RUNE_ID,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.quote).toBeDefined()
      expect(body.request).toBeDefined()
      expect(body.state).toBe('UNPAID')

      quoteId = body.quote
    })

    it('POST /v1/mint/quote/runes should fail with invalid amount', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/quote/runes',
        payload: {
          amount: -100,
          unit: UNIT,
          rune_id: RUNE_ID,
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid amount')
    })

    it('POST /v1/mint/quote/runes should fail with missing unit', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/quote/runes',
        payload: {
          amount: 1000,
          rune_id: RUNE_ID,
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Unit required')
    })

    it('POST /v1/mint/quote/runes should fail with missing rune_id', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/quote/runes',
        payload: {
          amount: 1000,
          unit: UNIT,
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Rune ID required')
    })

    it('GET /v1/mint/quote/runes/:quote_id should get quote status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/v1/mint/quote/runes/${quoteId}`,
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.quote).toBe(quoteId)
      expect(body.state).toBeDefined()
    })

    it('POST /v1/mint/runes should fail with unpaid quote', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/runes',
        payload: {
          quote: quoteId,
          outputs: [
            {
              amount: 1,
              id: keysetId,
              B_: '02' + '0'.repeat(64),
            },
          ],
        },
      })

      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBeDefined()
    })

    it('POST /v1/mint/runes should fail with missing quote', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/runes',
        payload: {
          outputs: [
            {
              amount: 1,
              id: keysetId,
              B_: '02' + '0'.repeat(64),
            },
          ],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Quote ID required')
    })

    it('POST /v1/mint/runes should fail with missing outputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/runes',
        payload: {
          quote: 'somequote',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid outputs')
    })

    it('POST /v1/mint/runes should fail with empty outputs array', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/mint/runes',
        payload: {
          quote: 'somequote',
          outputs: [],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid outputs')
    })
  })

  describe('Melt Routes', () => {
    let quoteId: string

    it('POST /v1/melt/quote/runes should create melt quote', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/quote/runes',
        payload: {
          amount: 1000,
          unit: UNIT,
          rune_id: RUNE_ID,
          request: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.quote).toBeDefined()
      expect(body.amount).toBe(1000)
      expect(body.fee_reserve).toBeDefined()

      quoteId = body.quote
    })

    it('POST /v1/melt/quote/runes should fail with invalid amount', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/quote/runes',
        payload: {
          amount: 0,
          unit: UNIT,
          rune_id: RUNE_ID,
          request: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid amount')
    })

    it('POST /v1/melt/quote/runes should fail with missing unit', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/quote/runes',
        payload: {
          amount: 1000,
          rune_id: RUNE_ID,
          request: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Unit required')
    })

    it('POST /v1/melt/quote/runes should fail with missing rune_id', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/quote/runes',
        payload: {
          amount: 1000,
          unit: UNIT,
          request: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Rune ID required')
    })

    it('POST /v1/melt/quote/runes should fail with missing destination address', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/quote/runes',
        payload: {
          amount: 1000,
          unit: UNIT,
          rune_id: RUNE_ID,
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Destination address required')
    })

    it('GET /v1/melt/quote/runes/:quote_id should get quote status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/v1/melt/quote/runes/${quoteId}`,
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.quote).toBe(quoteId)
    })

    it('POST /v1/melt/runes should fail with invalid inputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/runes',
        payload: {
          quote: quoteId,
          inputs: [],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid inputs')
    })

    it('POST /v1/melt/runes should fail with missing quote', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/runes',
        payload: {
          inputs: [
            {
              amount: 1,
              id: keysetId,
              secret: 'test',
              C: '02' + '0'.repeat(64),
            },
          ],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Quote ID required')
    })

    it('POST /v1/melt/runes should fail with missing inputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/melt/runes',
        payload: {
          quote: 'somequote',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid inputs')
    })
  })

  describe('Swap Routes', () => {
    it('POST /v1/swap should fail with invalid inputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/swap',
        payload: {
          inputs: [],
          outputs: [
            {
              amount: 1,
              id: keysetId,
              B_: '02' + '0'.repeat(64),
            },
          ],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid inputs')
    })

    it('POST /v1/swap should fail with missing inputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/swap',
        payload: {
          outputs: [
            {
              amount: 1,
              id: keysetId,
              B_: '02' + '0'.repeat(64),
            },
          ],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid inputs')
    })

    it('POST /v1/swap should fail with invalid outputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/swap',
        payload: {
          inputs: [
            {
              amount: 1,
              id: keysetId,
              secret: 'test',
              C: '02' + '0'.repeat(64),
            },
          ],
          outputs: [],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid outputs')
    })

    it('POST /v1/swap should fail with missing outputs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/swap',
        payload: {
          inputs: [
            {
              amount: 1,
              id: keysetId,
              secret: 'test',
              C: '02' + '0'.repeat(64),
            },
          ],
        },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Invalid outputs')
    })
  })
})
