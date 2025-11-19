import { FastifyPluginAsync } from 'fastify'
import { CheckStateService } from '../../core/services/CheckStateService.js'

interface CheckStateRequest {
  Ys: string[]
}

export const checkStateRoutes: FastifyPluginAsync = async (fastify) => {
  const checkStateService = fastify.diContainer.resolve<CheckStateService>('checkStateService')

  /**
   * POST /v1/checkstate
   * Check proof states by Y values (NUT-07)
   *
   * Request body:
   * {
   *   "Ys": ["02abc...", "03def..."]  // Array of hex-encoded compressed points
   * }
   *
   * Response:
   * {
   *   "states": [
   *     {
   *       "Y": "02abc...",
   *       "state": "UNSPENT|PENDING|SPENT",
   *       "witness": null | "..." // Witness data for spending conditions
   *     }
   *   ]
   * }
   */
  fastify.post<{ Body: CheckStateRequest }>('/v1/checkstate', async (request, reply) => {
    const { Ys } = request.body

    if (!Ys || !Array.isArray(Ys)) {
      return reply.code(400).send({ error: 'Invalid request: Ys must be an array' })
    }

    if (Ys.length === 0) {
      return reply.code(400).send({ error: 'Invalid request: Ys array is empty' })
    }

    // Validate that all Ys are hex strings (compressed secp256k1 points are 66 hex chars)
    const invalidYs = Ys.filter(Y => typeof Y !== 'string' || !/^[0-9a-fA-F]{66}$/.test(Y))
    if (invalidYs.length > 0) {
      return reply.code(400).send({
        error: 'Invalid request: Ys must be 66-character hex strings (compressed secp256k1 points)',
        invalid: invalidYs.slice(0, 3) // Show first 3 invalid values
      })
    }

    const result = await checkStateService.checkStateByYs(Ys)
    return reply.code(200).send(result)
  })
}
