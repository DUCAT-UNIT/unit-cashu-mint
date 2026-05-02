import { describe, expect, it, vi } from 'vitest'
import { SwapService } from '../../../src/core/services/SwapService.js'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto.js'
import { ProofRepository } from '../../../src/database/repositories/ProofRepository.js'
import { BlindedMessage, Proof } from '../../../src/types/cashu.js'
import { KeysetUnitMismatchError } from '../../../src/utils/errors.js'

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('SwapService', () => {
  it('rejects cross-unit swaps before spending proofs or signing outputs', async () => {
    const unitError = new KeysetUnitMismatchError('sat', 'unit', 'unit-keyset')
    const mintCrypto = {
      ensureProofsAndOutputsUseSingleUnit: vi.fn().mockRejectedValue(unitError),
      sumProofs: vi.fn(),
      calculateInputFees: vi.fn(),
      verifyProofsOrThrow: vi.fn(),
      hashSecret: vi.fn(),
      signBlindedMessages: vi.fn(),
    } as unknown as MintCrypto
    const proofRepo = {
      markSpent: vi.fn(),
    } as unknown as ProofRepository
    const service = new SwapService(mintCrypto, proofRepo)
    const inputs: Proof[] = [{ id: 'sat-keyset', amount: 8, secret: 'secret', C: '02proof' }]
    const outputs: BlindedMessage[] = [{ id: 'unit-keyset', amount: 8, B_: '02blind' }]

    await expect(service.swap(inputs, outputs)).rejects.toBe(unitError)

    expect(proofRepo.markSpent).not.toHaveBeenCalled()
    expect(mintCrypto.signBlindedMessages).not.toHaveBeenCalled()
  })
})
