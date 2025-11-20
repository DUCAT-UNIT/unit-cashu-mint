import { FastifyPluginAsync } from 'fastify'
import { SwapService } from '../../core/services/SwapService.js'
import { Proof, BlindedMessage } from '../../types/cashu.js'

interface SwapRequest {
  inputs: Proof[]
  outputs: BlindedMessage[]
}

export const swapRoutes: FastifyPluginAsync = async (fastify) => {
  const swapService = fastify.diContainer.resolve<SwapService>('swapService')

  /**
   * POST /v1/swap
   * Swap proofs for new blinded signatures (NUT-03)
   */
  fastify.post<{ Body: SwapRequest }>('/v1/swap', async (request, reply) => {
    const { inputs, outputs } = request.body

    if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
      return reply.code(400).send({ error: 'Invalid inputs' })
    }

    if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
      return reply.code(400).send({ error: 'Invalid outputs' })
    }

    try {
      const result = await swapService.swap(inputs, outputs)
      return reply.code(200).send(result)
    } catch (error: any) {
      if (error.code === 'P2PK_VERIFICATION_FAILED') {
        return reply.code(403).send({
          error: 'P2PK verification failed',
          detail: 'Proof is locked to a public key and requires a valid signature witness'
        })
      }
      throw error
    }
  })
}
