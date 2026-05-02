import { FastifyPluginAsync } from 'fastify'
import { KeyManager } from '../../core/crypto/KeyManager.js'
import { env } from '../../config/env.js'

export const keysRoutes: FastifyPluginAsync = async (fastify) => {
  const keyManager = fastify.diContainer.resolve<KeyManager>('keyManager')

  async function ensureAdvertisedKeysets(): Promise<void> {
    const targets: Array<{ runeId: string; unit: string }> = []

    if (env.SUPPORTED_UNITS_ARRAY.includes('unit') && env.SUPPORTED_RUNES_ARRAY[0]) {
      targets.push({ runeId: env.SUPPORTED_RUNES_ARRAY[0], unit: 'unit' })
    }

    if (env.SUPPORTS_BITCOIN || env.SUPPORTS_LIGHTNING) {
      targets.push({ runeId: 'btc:0', unit: 'sat' })
    }

    for (const target of targets) {
      const existing = await keyManager.getKeysetByRuneIdAndUnit(target.runeId, target.unit)
      if (!existing) {
        try {
          await keyManager.generateKeyset(target.runeId, target.unit)
        } catch (error: any) {
          if (error?.code !== '23505') {
            throw error
          }
        }
      }
    }
  }

  /**
   * GET /v1/keys
   * Get all active keysets (NUT-01)
   */
  fastify.get('/v1/keys', async (_request, reply) => {
    await ensureAdvertisedKeysets()
    const keysets = await keyManager.getActiveKeysets()

    // Return public keys for all active keysets
    const response = {
      keysets: keysets.map((keyset) => ({
        id: keyset.id,
        unit: keyset.unit,
        keys: keyset.public_keys,
      })),
    }

    return reply.code(200).send(response)
  })

  /**
   * GET /v1/keys/:keyset_id
   * Get public keys for a specific keyset (NUT-01)
   */
  fastify.get<{ Params: { keyset_id: string } }>(
    '/v1/keys/:keyset_id',
    async (request, reply) => {
      const { keyset_id } = request.params

      const keys = await keyManager.getPublicKeys(keyset_id)
      return reply.code(200).send({ keysets: [keys] })
    }
  )

  /**
   * GET /v1/keysets
   * Get list of all keysets (NUT-02)
   */
  fastify.get('/v1/keysets', async (_request, reply) => {
    await ensureAdvertisedKeysets()
    const keysets = await keyManager.getActiveKeysets()

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
