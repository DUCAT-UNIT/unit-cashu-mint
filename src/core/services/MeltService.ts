import { randomBytes } from 'crypto'
import { MintCrypto } from '../crypto/MintCrypto.js'
import { QuoteRepository } from '../../database/repositories/QuoteRepository.js'
import { ProofRepository } from '../../database/repositories/ProofRepository.js'
import { P2PKService } from './P2PKService.js'
import { Proof, MeltQuoteResponse } from '../../types/cashu.js'
import { AmountMismatchError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { RunesBackend } from '../../runes/RunesBackend.js'

export class MeltService {
  private p2pkService: P2PKService

  constructor(
    private mintCrypto: MintCrypto,
    private quoteRepo: QuoteRepository,
    private proofRepo: ProofRepository,
    private runesBackend: RunesBackend
  ) {
    this.p2pkService = new P2PKService()
  }

  /**
   * Create a melt quote for Runes withdrawal
   */
  async createMeltQuote(
    amount: number,
    unit: string,
    runeId: string,
    destination: string
  ): Promise<MeltQuoteResponse> {
    // Validate amount
    if (amount < env.MIN_MELT_AMOUNT || amount > env.MAX_MELT_AMOUNT) {
      throw new Error(
        `Amount must be between ${env.MIN_MELT_AMOUNT} and ${env.MAX_MELT_AMOUNT}`
      )
    }

    // Validate destination address
    if (!destination.startsWith('bc1') && !destination.startsWith('tb1')) {
      throw new Error('Invalid Bitcoin address')
    }

    // Generate quote ID
    const quoteId = randomBytes(32).toString('hex')

    // Convert amount to smallest unit (multiply by 100 for Runes 2 decimal places)
    // e.g., 9.23 UNIT → 923 in smallest units
    const amountInt = Math.round(amount * 100)

    // For UNIT mints, we don't charge a fee in Cashu tokens
    // The mint pays the BTC network fee itself
    // Optional: Set a small service fee in UNIT (e.g., 1-2 UNIT)
    const feeReserve = 0

    // Set expiry (1 hour from now for melts)
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60

    // Save quote to database
    const quote = await this.quoteRepo.createMeltQuote({
      id: quoteId,
      amount: amountInt,
      unit,
      rune_id: runeId,
      request: destination,
      fee_reserve: feeReserve,
      state: 'UNPAID',
      expiry,
    })

    logger.info({ quoteId, amount: amountInt, runeId, destination }, 'Melt quote created')

    return {
      quote: quote.id,
      amount: quote.amount,
      fee_reserve: quote.fee_reserve,
      state: quote.state,
      expiry: quote.expiry,
      request: quote.request,
      unit: quote.unit,
    }
  }

  /**
   * Get melt quote status
   */
  async getMeltQuote(quoteId: string): Promise<MeltQuoteResponse> {
    const quote = await this.quoteRepo.findMeltQuoteByIdOrThrow(quoteId)

    return {
      quote: quote.id,
      amount: quote.amount,
      fee_reserve: quote.fee_reserve,
      state: quote.state,
      expiry: quote.expiry,
      request: quote.request,
      unit: quote.unit,
      txid: quote.txid,
    }
  }

  /**
   * Melt tokens (redeem ecash for Runes)
   */
  async meltTokens(
    quoteId: string,
    inputs: Proof[]
  ): Promise<{ state: string; paid: boolean; payment_preimage?: string }> {
    logger.info({ quoteId, inputCount: inputs.length }, 'Melting tokens')

    // 1. Get quote
    const quote = await this.quoteRepo.findMeltQuoteByIdOrThrow(quoteId)

    // 2. Check quote not expired
    const now = Math.floor(Date.now() / 1000)
    if (now > quote.expiry) {
      throw new Error(`Quote ${quoteId} has expired`)
    }

    // 3. Verify input amounts cover quote amount
    // (No fee required - mint pays the BTC network fee)
    const inputAmount = this.mintCrypto.sumProofs(inputs)
    const requiredAmount = quote.amount

    if (inputAmount < requiredAmount) {
      throw new AmountMismatchError(requiredAmount, inputAmount)
    }

    // 4. Verify all input proofs have valid signatures
    await this.mintCrypto.verifyProofsOrThrow(inputs)

    // 4b. Verify P2PK spending conditions (NUT-11)
    for (const input of inputs) {
      if (this.p2pkService.isP2PKProof(input)) {
        const isValid = this.p2pkService.verifyP2PKProof(input)
        if (!isValid) {
          throw new Error(`P2PK witness verification failed for proof`)
        }
      }
    }

    // 4c. Verify SIG_ALL mode if applicable
    if (!this.p2pkService.verifyP2PKProofsWithSigAll(inputs)) {
      throw new Error('P2PK SIG_ALL verification failed')
    }

    // 5. Hash secrets to Y values for database lookup
    const Y_values = inputs.map((proof) => this.mintCrypto.hashSecret(proof.secret))

    // 6. Mark proofs as spent FIRST (to prevent double-spending)
    const transactionId = `melt_${quoteId}`
    await this.proofRepo.markSpent(inputs, Y_values, transactionId)

    // 7. Update quote to PENDING
    await this.quoteRepo.updateMeltQuoteState(quoteId, 'PENDING')

    logger.info(
      { quoteId, inputAmount, transactionId },
      'Proofs locked, initiating Runes withdrawal'
    )

    // 8. Initiate Runes withdrawal
    try {
      const result = await this.runesBackend.sendRunes(
        quote.request, // destination
        BigInt(quote.amount),
        quote.rune_id
      )

      // Update quote to PAID with txid
      await this.quoteRepo.updateMeltQuoteState(quoteId, 'PAID', result.txid)

      logger.info(
        { quoteId, txid: result.txid, feePaid: result.fee_paid },
        'Runes withdrawal completed - proofs permanently burned'
      )

      return {
        state: 'PAID',
        paid: true, // NUT-05: paid field indicates successful payment
        payment_preimage: result.txid, // Transaction ID as payment proof
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : String(error),
          quoteId,
          transactionId
        },
        'Runes withdrawal failed - reverting proofs to unspent'
      )

      // Revert proofs to unspent by deleting them from database
      const deletedCount = await this.proofRepo.deleteByTransactionId(transactionId)

      // Revert quote to UNPAID so user can retry
      await this.quoteRepo.updateMeltQuoteState(quoteId, 'UNPAID')

      logger.info(
        { quoteId, transactionId, deletedCount },
        'Proofs reverted to unspent, user can retry melt'
      )

      throw new Error('Runes withdrawal failed - your ecash tokens remain valid, please try again')
    }
  }

  /**
   * Complete a melt after Runes withdrawal succeeds
   * This would be called by the Runes backend monitoring service
   */
  async completeMelt(quoteId: string, txid: string): Promise<void> {
    await this.quoteRepo.updateMeltQuoteState(quoteId, 'PAID', txid)
    logger.info({ quoteId, txid }, 'Melt completed successfully')
  }

  /**
   * Fail a melt if Runes withdrawal fails
   * This would be called by the Runes backend monitoring service
   */
  async failMelt(quoteId: string): Promise<void> {
    // In production, we'd need to handle refunds here
    // For now, just mark as failed
    await this.quoteRepo.updateMeltQuoteState(quoteId, 'UNPAID')
    logger.error({ quoteId }, 'Melt failed - withdrawal unsuccessful')
  }
}
