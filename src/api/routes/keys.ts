import { FastifyPluginAsync } from 'fastify'
import { KeyManager } from '../../core/crypto/KeyManager.js'

export const keysRoutes: FastifyPluginAsync = async (fastify) => {
  const keyManager = fastify.diContainer.resolve<KeyManager>('keyManager')

  /**
   * GET /v1/keys
   * Get all active keysets (NUT-01)
   */
  fastify.get('/v1/keys', async (_request, reply) => {
    const keysets = await keyManager.reconcileConfiguredKeysets()

    // Return public keys for all active keysets
    const response = {
      keysets: keysets.map((keyset) => ({
        id: keyset.id,
        unit: keyset.unit,
        active: keyset.active,
        input_fee_ppk: keyset.input_fee_ppk ?? 0,
        final_expiry: keyset.final_expiry,
        keys: keyset.public_keys,
      })),
    }

    return reply.code(200).send(response)
  })

  /**
   * GET /v1/keys/:keyset_id
   * Get public keys for a specific keyset (NUT-01)
   */
  fastify.get<{ Params: { keyset_id: string } }>('/v1/keys/:keyset_id', async (request, reply) => {
    const { keyset_id } = request.params

    const keys = await keyManager.getPublicKeys(keyset_id)
    return reply.code(200).send({ keysets: [keys] })
  })

  /**
   * GET /v1/keysets
   * Get list of all keysets (NUT-02)
   */
  fastify.get('/v1/keysets', async (_request, reply) => {
    const keysets = await keyManager.reconcileConfiguredKeysets()

    const response = {
      keysets: keysets.map((keyset) => ({
        id: keyset.id,
        unit: keyset.unit,
        active: keyset.active,
        input_fee_ppk: keyset.input_fee_ppk ?? 0,
      })),
    }

    return reply.code(200).send(response)
  })
}
