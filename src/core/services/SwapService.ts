import { MintCrypto } from '../crypto/MintCrypto.js'
import { ProofRepository } from '../../database/repositories/ProofRepository.js'
import { Proof, BlindedMessage, BlindSignature } from '../../types/cashu.js'
import { AmountMismatchError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export class SwapService {
  constructor(
    private mintCrypto: MintCrypto,
    private proofRepo: ProofRepository
  ) {}

  /**
   * Swap proofs for new blinded signatures
   * This is the core operation that prevents double-spending
   */
  async swap(inputs: Proof[], outputs: BlindedMessage[]): Promise<{ signatures: BlindSignature[] }> {
    logger.info(
      { inputCount: inputs.length, outputCount: outputs.length },
      'Processing swap request'
    )

    // 1. Verify input amounts match output amounts
    const inputAmount = this.mintCrypto.sumProofs(inputs)
    const outputAmount = outputs.reduce((sum, o) => sum + o.amount, 0)

    if (inputAmount !== outputAmount) {
      throw new AmountMismatchError(outputAmount, inputAmount)
    }

    // 2. Verify all input proofs have valid signatures
    this.mintCrypto.verifyProofsOrThrow(inputs)

    // 3. Hash secrets to Y values for database lookup
    const Y_values = inputs.map((proof) => this.mintCrypto.hashSecret(proof.secret))

    // 4. Atomically mark proofs as spent (throws if already spent)
    const transactionId = `swap_${Date.now()}_${Math.random().toString(36).substring(7)}`
    await this.proofRepo.markSpent(inputs, Y_values, transactionId)

    // 5. Sign output blinded messages
    const signatures = this.mintCrypto.signBlindedMessages(outputs)

    logger.info(
      { transactionId, inputAmount, outputCount: signatures.length },
      'Swap completed successfully'
    )

    return { signatures }
  }
}
