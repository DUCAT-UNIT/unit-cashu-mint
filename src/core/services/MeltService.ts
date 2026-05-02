import { randomBytes } from 'crypto'
import { MintCrypto } from '../crypto/MintCrypto.js'
import { QuoteRepository } from '../../database/repositories/QuoteRepository.js'
import { ProofRepository } from '../../database/repositories/ProofRepository.js'
import { P2PKService } from './P2PKService.js'
import { BlindedMessage, BlindSignature, Proof, MeltQuoteResponse, OnchainMeltQuoteResponse } from '../../types/cashu.js'
import { AmountMismatchError, MintError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { BackendRegistry } from '../payment/BackendRegistry.js'
import { notificationBus } from '../events/notifications.js'
import { SignatureRepository } from '../../database/repositories/SignatureRepository.js'

export class MeltService {
  private p2pkService: P2PKService

  constructor(
    private mintCrypto: MintCrypto,
    private quoteRepo: QuoteRepository,
    private proofRepo: ProofRepository,
    private backendRegistry: BackendRegistry,
    private signatureRepo?: SignatureRepository
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
    destination: string,
    method: string = 'unit',
    fee: number = 0,
    estimatedBlocks?: number,
    feeReserve: number = 0
  ): Promise<MeltQuoteResponse> {
    // Validate amount
    if (amount < env.MIN_MELT_AMOUNT || amount > env.MAX_MELT_AMOUNT) {
      throw new Error(
        `Amount must be between ${env.MIN_MELT_AMOUNT} and ${env.MAX_MELT_AMOUNT}`
      )
    }

    // Validate destination address for on-chain methods.
    if (
      method !== 'bolt11' &&
      !destination.startsWith('bc1') &&
      !destination.startsWith('tb1') &&
      !destination.startsWith('bcrt1')
    ) {
      throw new Error('Invalid Bitcoin address')
    }

    // Generate quote ID
    const quoteId = randomBytes(32).toString('hex')

    // Amount is already in smallest units (integer)

    // For UNIT mints, we don't charge a fee in Cashu tokens
    // The mint pays the BTC network fee itself
    // Optional: Set a small service fee in UNIT (e.g., 1-2 UNIT)

    // Set expiry (1 hour from now for melts)
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60

    // Save quote to database
    const quote = await this.quoteRepo.createMeltQuote({
      id: quoteId,
      amount,
      unit,
      rune_id: runeId,
      method,
      request: destination,
      fee_reserve: feeReserve,
      state: 'UNPAID',
      expiry,
      fee,
      estimated_blocks: estimatedBlocks,
    })

    logger.info({ quoteId, amount, runeId, destination }, 'Melt quote created')

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

  async createBolt11MeltQuote(
    unit: string,
    request: string,
    amount?: number
  ): Promise<MeltQuoteResponse> {
    const decodedAmount = amount ?? this.decodeBolt11AmountSats(request)
    const backend = this.backendRegistry.getByMethod('bolt11', unit)
    const feeReserve = await backend.estimateFee(request, BigInt(decodedAmount))

    return this.createMeltQuote(
      decodedAmount,
      unit,
      'btc:0',
      request,
      'bolt11',
      0,
      undefined,
      feeReserve
    )
  }

  async createOnchainMeltQuotes(
    amount: number,
    unit: string,
    destination: string,
    runeId?: string
  ): Promise<OnchainMeltQuoteResponse[]> {
    if (amount < env.MIN_MELT_AMOUNT || amount > env.MAX_MELT_AMOUNT) {
      throw new Error(
        `Amount must be between ${env.MIN_MELT_AMOUNT} and ${env.MAX_MELT_AMOUNT}`
      )
    }

    const backend = this.backendRegistry.getByMethod('onchain', unit)
    const fee = await backend.estimateFee(destination, BigInt(amount))
    const quote = await this.createMeltQuote(
      amount,
      unit,
      this.defaultRuneIdForUnit(unit, runeId),
      destination,
      'onchain',
      fee,
      1
    )

    return [
      {
        quote: quote.quote,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        fee,
        estimated_blocks: 1,
        state: quote.state,
        expiry: quote.expiry,
      },
    ]
  }

  /**
   * Get melt quote status
   */
  async getMeltQuote(quoteId: string): Promise<MeltQuoteResponse | OnchainMeltQuoteResponse> {
    const quote = await this.quoteRepo.findMeltQuoteByIdOrThrow(quoteId)

    if (quote.method === 'onchain') {
      return {
        quote: quote.id,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        fee: quote.fee ?? quote.fee_paid ?? 0,
        estimated_blocks: quote.estimated_blocks ?? 1,
        state: quote.state,
        expiry: quote.expiry,
        outpoint: quote.outpoint ?? quote.txid,
      }
    }

    return {
      quote: quote.id,
      amount: quote.amount,
      fee_reserve: quote.fee_reserve,
      state: quote.state,
      expiry: quote.expiry,
      request: quote.request,
      unit: quote.unit,
      txid: quote.txid,
      payment_preimage: quote.method === 'bolt11' ? quote.txid ?? null : undefined,
      change: quote.change,
    }
  }

  /**
   * Melt tokens (redeem ecash for Runes)
   */
  async meltTokens(
    quoteId: string,
    inputs: Proof[],
    outputs: BlindedMessage[] = []
  ): Promise<
    { state: string; paid: boolean; payment_preimage?: string; change?: BlindSignature[] } | MeltQuoteResponse | OnchainMeltQuoteResponse
  > {
    logger.info({ quoteId, inputCount: inputs.length }, 'Melting tokens')

    // 1. Get quote
    const quote = await this.quoteRepo.findMeltQuoteByIdOrThrow(quoteId)

    // 2. Check quote not expired
    const now = Math.floor(Date.now() / 1000)
    if (now > quote.expiry) {
      throw new Error(`Quote ${quoteId} has expired`)
    }

    if (quote.method === 'bolt11') {
      if (quote.state === 'PAID') {
        throw new MintError('Request already paid', 20006, 'Request already paid')
      }
      if (quote.state === 'PENDING') {
        throw new MintError('Quote is pending', 20005, 'Quote is pending')
      }

      const settledQuote = await this.quoteRepo.findSettledMeltQuoteByRequest(
        quote.request,
        quote.method,
        quote.unit,
        quote.id
      )
      if (settledQuote) {
        throw new MintError('Request already paid', 20006, 'Request already paid')
      }
    }

    // 3. Verify input amounts cover quote amount and advertised fee reserve.
    const inputAmount = this.mintCrypto.sumProofs(inputs)
    const inputFees = await this.mintCrypto.calculateInputFees(inputs)
    const reservedAmount = quote.method === 'onchain'
      ? quote.amount + (quote.fee ?? 0) + inputFees
      : quote.amount + quote.fee_reserve + inputFees

    if (inputAmount < reservedAmount) {
      throw new AmountMismatchError(reservedAmount, inputAmount)
    }

    const maxChangeAmount = quote.method === 'bolt11'
      ? inputAmount - quote.amount - inputFees
      : inputAmount - reservedAmount
    this.validateChangeOutputs(outputs, maxChangeAmount)

    // 4. Verify all input proofs have valid signatures
    await this.mintCrypto.verifyProofsOrThrow(inputs)

    // 4b. Verify P2PK spending conditions (NUT-11), including SIG_ALL melts.
    if (!this.p2pkService.verifyP2PKProofs(inputs, outputs, quoteId)) {
      const message = 'Witness P2PK signatures not provided or invalid'
      throw new MintError(message, 20008, message)
    }

    // 5. Hash secrets to Y values for database lookup
    const Y_values = inputs.map((proof) => this.mintCrypto.hashSecret(proof.secret))

    // 6. Mark proofs as spent FIRST (to prevent double-spending)
    const transactionId = `melt_${quoteId}`
    await this.proofRepo.markSpent(inputs, Y_values, transactionId)

    // 7. Update quote to PENDING
    await this.quoteRepo.updateMeltQuoteState(quoteId, 'PENDING')
    if (quote.method === 'bolt11') {
      notificationBus.publish('bolt11_melt_quote', {
        quote: quote.id,
        amount: quote.amount,
        fee_reserve: quote.fee_reserve,
        state: 'PENDING',
        expiry: quote.expiry,
        request: quote.request,
        unit: quote.unit,
        payment_preimage: null,
      })
    }

    logger.info(
      { quoteId, inputAmount, transactionId },
      'Proofs locked, initiating Runes withdrawal'
    )

    // 8. Initiate withdrawal using the appropriate backend
    try {
      const backend = this.backendRegistry.getByMethod(quote.method, quote.unit)
      const result = await backend.withdraw(
        quote.request, // destination
        BigInt(quote.amount)
      )

      const nextState = quote.method === 'onchain' ? 'PENDING' : 'PAID'
      const outpoint = quote.method === 'onchain' ? `${result.txid}:0` : undefined
      const spentAmount = quote.method === 'bolt11'
        ? quote.amount + result.fee_paid + inputFees
        : reservedAmount
      const changeAmount = inputAmount - spentAmount
      const change = await this.signChangeOutputs(outputs, changeAmount)

      await this.quoteRepo.updateMeltQuoteState(
        quoteId,
        nextState,
        result.txid,
        result.fee_paid,
        outpoint,
        change
      )
      if (quote.method === 'bolt11') {
        notificationBus.publish('bolt11_melt_quote', {
          quote: quote.id,
          amount: quote.amount,
          fee_reserve: quote.fee_reserve,
          state: nextState,
          expiry: quote.expiry,
          request: quote.request,
          unit: quote.unit,
          payment_preimage: result.txid,
        })
      }

      logger.info(
        { quoteId, txid: result.txid, feePaid: result.fee_paid, unit: quote.unit },
        'Withdrawal completed - proofs permanently burned'
      )

      if (quote.method === 'onchain') {
        return {
          quote: quote.id,
          request: quote.request,
          amount: quote.amount,
          unit: quote.unit,
          fee: quote.fee ?? result.fee_paid,
          estimated_blocks: quote.estimated_blocks ?? 1,
          state: 'PENDING',
          expiry: quote.expiry,
          outpoint,
        }
      }

      if (quote.method === 'bolt11') {
        return {
          quote: quote.id,
          amount: quote.amount,
          fee_reserve: quote.fee_reserve,
          state: 'PAID',
          expiry: quote.expiry,
          request: quote.request,
          unit: quote.unit,
          payment_preimage: result.txid,
          change,
        }
      }

      return {
        state: 'PAID',
        paid: true, // NUT-05: paid field indicates successful payment
        payment_preimage: result.txid, // Transaction ID as payment proof
        change,
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
        'Withdrawal failed - reverting proofs to unspent'
      )

      // Revert proofs to unspent by deleting them from database
      const deletedCount = await this.proofRepo.deleteByTransactionId(transactionId)

      // Revert quote to UNPAID so user can retry
      await this.quoteRepo.updateMeltQuoteState(quoteId, 'UNPAID')

      logger.info(
        { quoteId, transactionId, deletedCount },
        'Proofs reverted to unspent, user can retry melt'
      )

      throw new Error('Withdrawal failed - your ecash tokens remain valid, please try again')
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

  private decodeBolt11AmountSats(invoice: string): number {
    const normalized = invoice.toLowerCase()
    const match = normalized.match(/^ln(?:bc|tb|bcrt|sb)(\d+)([munp]?)/)
    if (!match) {
      throw new Error('Amountless or invalid bolt11 invoice is not supported')
    }

    const amount = Number(match[1])
    const multiplier = match[2] || ''
    const sats = multiplier === 'm'
      ? amount * 100_000
      : multiplier === 'u'
        ? amount * 100
        : multiplier === 'n'
          ? amount / 10
          : multiplier === 'p'
            ? amount / 10_000
            : amount * 100_000_000

    if (!Number.isInteger(sats) || sats <= 0) {
      throw new Error('Bolt11 invoice amount must resolve to whole sats')
    }

    return sats
  }

  private validateChangeOutputs(outputs: BlindedMessage[], maxChangeAmount: number): void {
    if (outputs.length === 0 || maxChangeAmount <= 0) {
      return
    }

    const explicitAmount = outputs.reduce((sum, output) => sum + output.amount, 0)
    if (explicitAmount > maxChangeAmount) {
      throw new AmountMismatchError(maxChangeAmount, explicitAmount)
    }

    if (explicitAmount === 0 && this.splitAmount(maxChangeAmount).length > outputs.length) {
      throw new Error('Insufficient blank outputs for melt change')
    }
  }

  private async signChangeOutputs(
    outputs: BlindedMessage[],
    changeAmount: number
  ): Promise<BlindSignature[]> {
    if (outputs.length === 0 || changeAmount <= 0) {
      return []
    }

    const explicitAmount = outputs.reduce((sum, output) => sum + output.amount, 0)
    if (explicitAmount > 0) {
      if (explicitAmount !== changeAmount) {
        throw new AmountMismatchError(changeAmount, explicitAmount)
      }

      const explicitOutputs = outputs.filter((output) => output.amount > 0)
      const signatures = await this.mintCrypto.signBlindedMessages(explicitOutputs)
      await this.signatureRepo?.saveMany(explicitOutputs, signatures)
      return signatures
    }

    const denominations = this.splitAmount(changeAmount)
    if (denominations.length > outputs.length) {
      throw new Error('Insufficient blank outputs for melt change')
    }

    const changeOutputs = denominations.map((amount, index) => ({
      ...outputs[index],
      amount,
    }))

    const signatures = await this.mintCrypto.signBlindedMessages(changeOutputs)
    await this.signatureRepo?.saveMany(changeOutputs, signatures)
    return signatures
  }

  private splitAmount(amount: number): number[] {
    const denominations: number[] = []
    let remaining = amount
    let bit = 1

    while (remaining > 0) {
      if (remaining % 2 === 1) {
        denominations.push(bit)
      }

      remaining = Math.floor(remaining / 2)
      bit *= 2
    }

    return denominations.reverse()
  }

  private defaultRuneIdForUnit(unit: string, runeId?: string): string {
    if (runeId) {
      return runeId
    }

    if (unit === 'unit') {
      const supportedRuneId = env.SUPPORTED_RUNES_ARRAY[0]
      if (!supportedRuneId) {
        throw new Error('Rune ID required for unit')
      }

      return supportedRuneId
    }

    return 'btc:0'
  }
}
