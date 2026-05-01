import { FastifyPluginAsync } from 'fastify'
import { MeltService } from '../../core/services/MeltService.js'
import { BackendRegistry } from '../../core/payment/BackendRegistry.js'
import { Proof } from '../../types/cashu.js'

interface MeltQuoteRequest {
  amount?: number
  unit: string
  rune_id?: string // Optional - required for 'unit' (Runes) unit only
  request: string // destination address
}

interface MeltTokensRequest {
  quote: string
  inputs: Proof[]
}

export const meltRoutes: FastifyPluginAsync = async (fastify) => {
  const meltService = fastify.diContainer.resolve<MeltService>('meltService')
  const backendRegistry = fastify.diContainer.resolve<BackendRegistry>('backendRegistry')

  /**
   * POST /v1/melt/quote/:method
   * Create a melt quote for withdrawal (NUT-05)
   */
  fastify.post<{ Params: { method: string }; Body: MeltQuoteRequest }>(
    '/v1/melt/quote/:method',
    async (request, reply) => {
      const { method } = request.params
      const { amount, unit, rune_id, request: destination } = request.body

      if (!unit) {
        return reply.code(400).send({ error: 'Unit required' })
      }

      // Validate unit is supported
      if (!backendRegistry.has(unit)) {
        return reply.code(400).send({ error: `Unsupported unit: ${unit}` })
      }

      if (!destination) {
        return reply.code(400).send({ error: 'Destination address required' })
      }

      if (method === 'onchain') {
        if (!amount || amount <= 0 || !Number.isInteger(amount)) {
          return reply.code(400).send({ error: 'Invalid amount - must be a positive integer (smallest units)' })
        }
        if (!backendRegistry.hasMethod('onchain', unit)) {
          return reply.code(400).send({ error: `Unsupported method/unit: onchain/${unit}` })
        }
        const quotes = await meltService.createOnchainMeltQuotes(amount, unit, destination, rune_id)
        return reply.code(200).send(quotes)
      }

      if (method === 'bolt11') {
        if (!backendRegistry.hasMethod('bolt11', unit)) {
          return reply.code(400).send({ error: `Unsupported method/unit: bolt11/${unit}` })
        }
        const quote = await meltService.createBolt11MeltQuote(unit, destination, amount)
        return reply.code(200).send(quote)
      }

      if (method !== 'unit' && method !== 'runes') {
        return reply.code(400).send({ error: `Unsupported melt method: ${method}` })
      }

      const quoteMethod = method === 'runes' ? 'unit' : method
      if (!backendRegistry.hasMethod(quoteMethod, unit)) {
        return reply.code(400).send({ error: `Unsupported method/unit: ${quoteMethod}/${unit}` })
      }

      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        return reply.code(400).send({ error: 'Invalid amount - must be a positive integer (smallest units)' })
      }

      // For 'unit' (Runes), rune_id is required
      if (unit === 'unit' && !rune_id) {
        return reply.code(400).send({ error: 'Rune ID required for unit' })
      }

      // For 'btc' unit, use a placeholder rune_id
      const effectiveRuneId = rune_id || 'btc:0'

      const quote = await meltService.createMeltQuote(amount, unit, effectiveRuneId, destination, quoteMethod)
      return reply.code(200).send(quote)
    }
  )

  /**
   * GET /v1/melt/quote/:method/:quote_id
   * Get melt quote status (NUT-05)
   */
  fastify.get<{ Params: { method: string; quote_id: string } }>(
    '/v1/melt/quote/:method/:quote_id',
    async (request, reply) => {
      const { quote_id } = request.params

      const quote = await meltService.getMeltQuote(quote_id)
      return reply.code(200).send(quote)
    }
  )

  /**
   * POST /v1/melt/:method
   * Melt tokens to withdraw Runes (NUT-05)
   */
  fastify.post<{ Params: { method: string }; Body: MeltTokensRequest }>(
    '/v1/melt/:method',
    async (request, reply) => {
      const { quote, inputs } = request.body

      if (!quote) {
        return reply.code(400).send({ error: 'Quote ID required' })
      }

      if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
        return reply.code(400).send({ error: 'Invalid inputs' })
      }

      const result = await meltService.meltTokens(quote, inputs)
      return reply.code(200).send(result)
    }
  )
}
