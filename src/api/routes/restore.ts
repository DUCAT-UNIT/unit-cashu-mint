import { FastifyPluginAsync } from 'fastify'
import { SignatureRepository } from '../../database/repositories/SignatureRepository.js'
import { BlindedMessage } from '../../types/cashu.js'

interface RestoreRequest {
  outputs: BlindedMessage[]
}

export const restoreRoutes: FastifyPluginAsync = async (fastify) => {
  const signatureRepo = fastify.diContainer.resolve<SignatureRepository>('signatureRepository')

  fastify.post<{ Body: RestoreRequest }>('/v1/restore', async (request, reply) => {
    const { outputs } = request.body

    if (!outputs || !Array.isArray(outputs)) {
      return reply.code(400).send({ error: 'Invalid outputs' })
    }

    const result = await signatureRepo.restore(outputs)
    return reply.code(200).send(result)
  })
}
