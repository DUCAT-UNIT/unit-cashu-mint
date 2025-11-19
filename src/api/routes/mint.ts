import { FastifyPluginAsync } from 'fastify'
import { MintService } from '../../core/services/MintService.js'
import { BlindedMessage } from '../../types/cashu.js'

interface MintQuoteRequest {
  amount: number
  unit: string
  rune_id: string
}

interface MintTokensRequest {
  quote: string
  outputs: BlindedMessage[]
}

export const mintRoutes: FastifyPluginAsync = async (fastify) => {
  const mintService = fastify.diContainer.resolve<MintService>('mintService')

  /**
   * POST /v1/mint/quote/runes
   * Create a mint quote for Runes deposit (NUT-04)
   */
  fastify.post<{ Body: MintQuoteRequest }>(
    '/v1/mint/quote/runes',
    async (request, reply) => {
      const { amount, unit, rune_id } = request.body

      if (!amount || amount <= 0) {
        return reply.code(400).send({ error: 'Invalid amount' })
      }

      if (!unit) {
        return reply.code(400).send({ error: 'Unit required' })
      }

      if (!rune_id) {
        return reply.code(400).send({ error: 'Rune ID required' })
      }

      const quote = await mintService.createMintQuote(amount, unit, rune_id)
      return reply.code(200).send(quote)
    }
  )

  /**
   * GET /v1/mint/quote/runes/:quote_id
   * Get mint quote status (NUT-04)
   */
  fastify.get<{ Params: { quote_id: string } }>(
    '/v1/mint/quote/runes/:quote_id',
    async (request, reply) => {
      const { quote_id } = request.params

      const quote = await mintService.getMintQuote(quote_id)
      return reply.code(200).send(quote)
    }
  )

  /**
   * POST /v1/mint/runes
   * Mint tokens after quote is paid (NUT-04)
   */
  fastify.post<{ Body: MintTokensRequest }>(
    '/v1/mint/runes',
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
