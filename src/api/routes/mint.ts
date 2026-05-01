import { FastifyPluginAsync } from 'fastify'
import { MintService } from '../../core/services/MintService.js'
import { BackendRegistry } from '../../core/payment/BackendRegistry.js'
import { BlindedMessage } from '../../types/cashu.js'

interface MintQuoteRequest {
  amount?: number
  unit: string
  rune_id?: string // Optional - required for 'unit' (Runes) unit only
  pubkey?: string
  description?: string
}

interface MintTokensRequest {
  quote: string
  outputs: BlindedMessage[]
  signature?: string
}

export const mintRoutes: FastifyPluginAsync = async (fastify) => {
  const mintService = fastify.diContainer.resolve<MintService>('mintService')
  const backendRegistry = fastify.diContainer.resolve<BackendRegistry>('backendRegistry')

  /**
   * POST /v1/mint/quote/:method
   * Create a mint quote for deposit (NUT-04)
   */
  fastify.post<{ Params: { method: string }; Body: MintQuoteRequest }>(
    '/v1/mint/quote/:method',
    async (request, reply) => {
      const { method } = request.params
      const { amount, unit, rune_id, pubkey } = request.body

      if (!unit) {
        return reply.code(400).send({ error: 'Unit required' })
      }

      if (method === 'onchain') {
        if (!pubkey) {
          return reply.code(400).send({ error: 'Pubkey required for onchain mint quotes' })
        }

        if (!backendRegistry.has(unit)) {
          return reply.code(400).send({ error: `Unsupported unit: ${unit}` })
        }

        if (!backendRegistry.hasMethod('onchain', unit)) {
          return reply.code(400).send({ error: `Unsupported method/unit: onchain/${unit}` })
        }

        const quote = await mintService.createOnchainMintQuote(unit, pubkey, rune_id)
        return reply.code(200).send(quote)
      }

      if (method !== 'unit' && method !== 'runes' && method !== 'bolt11') {
        return reply.code(400).send({ error: `Unsupported mint method: ${method}` })
      }

      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        return reply.code(400).send({ error: 'Invalid amount - must be a positive integer (smallest units)' })
      }

      // Validate unit is supported
      if (!backendRegistry.has(unit)) {
        return reply.code(400).send({ error: `Unsupported unit: ${unit}` })
      }

      const quoteMethod = method === 'runes' ? 'unit' : method
      if (!backendRegistry.hasMethod(quoteMethod, unit)) {
        return reply.code(400).send({ error: `Unsupported method/unit: ${quoteMethod}/${unit}` })
      }

      // For 'unit' (Runes), rune_id is required
      if (unit === 'unit' && !rune_id) {
        return reply.code(400).send({ error: 'Rune ID required for unit' })
      }

      // For 'btc' unit, use a placeholder rune_id
      const effectiveRuneId = rune_id || 'btc:0'

      const quote = await mintService.createMintQuote(amount, unit, effectiveRuneId, quoteMethod, pubkey)
      return reply.code(200).send(quote)
    }
  )

  /**
   * GET /v1/mint/quote/:method/:quote_id
   * Get mint quote status (NUT-04)
   */
  fastify.get<{ Params: { method: string; quote_id: string } }>(
    '/v1/mint/quote/:method/:quote_id',
    async (request, reply) => {
      const { quote_id } = request.params

      const quote = await mintService.getMintQuote(quote_id)
      return reply.code(200).send(quote)
    }
  )

  /**
   * POST /v1/mint/:method
   * Mint tokens after quote is paid (NUT-04)
   */
  fastify.post<{ Params: { method: string }; Body: MintTokensRequest }>(
    '/v1/mint/:method',
    async (request, reply) => {
      const { quote, outputs, signature } = request.body

      if (!quote) {
        return reply.code(400).send({ error: 'Quote ID required' })
      }

      if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
        return reply.code(400).send({ error: 'Invalid outputs' })
      }

      const result = await mintService.mintTokens(quote, outputs, signature)
      return reply.code(200).send(result)
    }
  )
}
