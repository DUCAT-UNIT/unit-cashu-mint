import { FastifyPluginAsync } from 'fastify'
import { MintService } from '../../core/services/MintService.js'
import { BackendRegistry } from '../../core/payment/BackendRegistry.js'
import { BlindedMessage } from '../../types/cashu.js'

interface MintQuoteRequest {
  amount: number
  unit: string
  rune_id?: string // Optional - required for 'unit' (Runes) unit only
}

interface MintTokensRequest {
  quote: string
  outputs: BlindedMessage[]
}

export const mintRoutes: FastifyPluginAsync = async (fastify) => {
  const mintService = fastify.diContainer.resolve<MintService>('mintService')
  const backendRegistry = fastify.diContainer.resolve<BackendRegistry>('backendRegistry')

  /**
   * POST /v1/mint/quote/unit
   * Create a mint quote for deposit (NUT-04)
   */
  fastify.post<{ Body: MintQuoteRequest }>(
    '/v1/mint/quote/unit',
    async (request, reply) => {
      const { amount, unit, rune_id } = request.body

      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        return reply.code(400).send({ error: 'Invalid amount - must be a positive integer (smallest units)' })
      }

      if (!unit) {
        return reply.code(400).send({ error: 'Unit required' })
      }

      // Validate unit is supported
      if (!backendRegistry.has(unit)) {
        return reply.code(400).send({ error: `Unsupported unit: ${unit}` })
      }

      // For 'unit' (Runes), rune_id is required
      if (unit === 'unit' && !rune_id) {
        return reply.code(400).send({ error: 'Rune ID required for unit' })
      }

      // For 'btc' unit, use a placeholder rune_id
      const effectiveRuneId = rune_id || 'btc:0'

      const quote = await mintService.createMintQuote(amount, unit, effectiveRuneId)
      return reply.code(200).send(quote)
    }
  )

  /**
   * GET /v1/mint/quote/unit/:quote_id
   * Get mint quote status (NUT-04)
   */
  fastify.get<{ Params: { quote_id: string } }>(
    '/v1/mint/quote/unit/:quote_id',
    async (request, reply) => {
      const { quote_id } = request.params

      const quote = await mintService.getMintQuote(quote_id)
      return reply.code(200).send(quote)
    }
  )

  /**
   * POST /v1/mint/unit
   * Mint tokens after quote is paid (NUT-04)
   */
  fastify.post<{ Body: MintTokensRequest }>(
    '/v1/mint/unit',
    async (request, reply) => {
      const { quote, outputs } = request.body

      if (!quote) {
        return reply.code(400).send({ error: 'Quote ID required' })
      }

      if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
        return reply.code(400).send({ error: 'Invalid outputs' })
      }

      const result = await mintService.mintTokens(quote, outputs)
      return reply.code(200).send(result)
    }
  )
}
