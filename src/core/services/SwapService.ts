import { MintCrypto } from '../crypto/MintCrypto.js'
import { ProofRepository } from '../../database/repositories/ProofRepository.js'
import { P2PKService } from './P2PKService.js'
import { Proof, BlindedMessage, BlindSignature } from '../../types/cashu.js'
import { AmountMismatchError, MintError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { SignatureRepository } from '../../database/repositories/SignatureRepository.js'

export class SwapService {
  private p2pkService: P2PKService

  constructor(
    private mintCrypto: MintCrypto,
    private proofRepo: ProofRepository,
    private signatureRepo?: SignatureRepository
  ) {
    this.p2pkService = new P2PKService()
  }

  /**
   * Swap proofs for new blinded signatures
   * This is the core operation that prevents double-spending
   */
  async swap(inputs: Proof[], outputs: BlindedMessage[]): Promise<{ signatures: BlindSignature[] }> {
    // 1. Verify input amounts match output amounts
    const inputAmount = this.mintCrypto.sumProofs(inputs)
    const inputFees = await this.mintCrypto.calculateInputFees(inputs)
    const outputAmount = outputs.reduce((sum, o) => sum + o.amount, 0)
    const expectedOutputAmount = inputAmount - inputFees

    logger.info(
      {
        inputCount: inputs.length,
        outputCount: outputs.length,
        inputAmount,
        inputFees,
        outputAmount,
        inputAmounts: inputs.map(p => p.amount),
        outputAmounts: outputs.map(o => o.amount)
      },
      'Processing swap request'
    )

    if (outputAmount !== expectedOutputAmount) {
      throw new AmountMismatchError(expectedOutputAmount, outputAmount)
    }

    // 2. Verify all input proofs have valid signatures
    await this.mintCrypto.verifyProofsOrThrow(inputs)

    // 2b. Verify P2PK spending conditions (NUT-11), including SIG_ALL.
    if (!this.p2pkService.verifyP2PKProofs(inputs, outputs)) {
      const message = 'Witness P2PK signatures not provided or invalid'
      throw new MintError(message, 20008, message)
    }

    // 3. Hash secrets to Y values for database lookup
    const Y_values = inputs.map((proof) => this.mintCrypto.hashSecret(proof.secret))

    // 4. Atomically mark proofs as spent (throws if already spent)
    const transactionId = `swap_${Date.now()}_${Math.random().toString(36).substring(7)}`
    await this.proofRepo.markSpent(inputs, Y_values, transactionId)

    // 5. Sign output blinded messages
    const signatures = await this.mintCrypto.signBlindedMessages(outputs)
    await this.signatureRepo?.saveMany(outputs, signatures)

    logger.info(
      { transactionId, inputAmount, outputCount: signatures.length },
      'Swap completed successfully'
    )

    return { signatures }
  }
}
