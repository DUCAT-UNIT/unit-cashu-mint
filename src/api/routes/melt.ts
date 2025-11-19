import { FastifyPluginAsync } from 'fastify'
import { MeltService } from '../../core/services/MeltService.js'
import { Proof } from '../../types/cashu.js'

interface MeltQuoteRequest {
  amount: number
  unit: string
  rune_id: string
  request: string // destination address
}

interface MeltTokensRequest {
  quote: string
  inputs: Proof[]
}

export const meltRoutes: FastifyPluginAsync = async (fastify) => {
  const meltService = fastify.diContainer.resolve<MeltService>('meltService')

  /**
   * POST /v1/melt/quote/runes
   * Create a melt quote for Runes withdrawal (NUT-05)
   */
  fastify.post<{ Body: MeltQuoteRequest }>(
    '/v1/melt/quote/runes',
    async (request, reply) => {
      const { amount, unit, rune_id, request: destination } = request.body

      if (!amount || amount <= 0) {
        return reply.code(400).send({ error: 'Invalid amount' })
      }

      if (!unit) {
        return reply.code(400).send({ error: 'Unit required' })
      }

      if (!rune_id) {
        return reply.code(400).send({ error: 'Rune ID required' })
      }

      if (!destination) {
        return reply.code(400).send({ error: 'Destination address required' })
      }

      const quote = await meltService.createMeltQuote(amount, unit, rune_id, destination)
      return reply.code(200).send(quote)
    }
  )

  /**
   * GET /v1/melt/quote/runes/:quote_id
   * Get melt quote status (NUT-05)
   */
  fastify.get<{ Params: { quote_id: string } }>(
    '/v1/melt/quote/runes/:quote_id',
    async (request, reply) => {
      const { quote_id } = request.params

      const quote = await meltService.getMeltQuote(quote_id)
      return reply.code(200).send(quote)
    }
  )

  /**
   * POST /v1/melt/runes
   * Melt tokens to withdraw Runes (NUT-05)
   */
  fastify.post<{ Body: MeltTokensRequest }>(
    '/v1/melt/runes',
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
