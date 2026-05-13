import { randomBytes } from 'crypto'
import { verifyMintQuoteSignature as cashuVerifyMintQuoteSignature } from '@cashu/cashu-ts'
import { MintCrypto } from '../crypto/MintCrypto.js'
import { KeyManager } from '../crypto/KeyManager.js'
import { QuoteRepository } from '../../database/repositories/QuoteRepository.js'
import {
  BlindedMessage,
  BlindSignature,
  MintQuoteResponse,
  OnchainMintQuoteResponse,
} from '../../types/cashu.js'
import { AmountMismatchError, hasErrorCode, MintError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { BackendRegistry } from '../payment/BackendRegistry.js'
import { notificationBus } from '../events/notifications.js'
import { SignatureRepository } from '../../database/repositories/SignatureRepository.js'

export class MintService {
  constructor(
    private mintCrypto: MintCrypto,
    private quoteRepo: QuoteRepository,
    private backendRegistry: BackendRegistry,
    private keyManager: KeyManager,
    private signatureRepo?: SignatureRepository
  ) {}

  /**
   * Create a mint quote for Runes deposit
   */
  async createMintQuote(
    amount: number,
    unit: string,
    runeId: string,
    method: string = 'unit',
    pubkey?: string
  ): Promise<MintQuoteResponse> {
    if (pubkey) {
      this.validatePubkey(pubkey)
    }

    // Validate amount
    if (amount < env.MIN_MINT_AMOUNT || amount > env.MAX_MINT_AMOUNT) {
      throw new Error(`Amount must be between ${env.MIN_MINT_AMOUNT} and ${env.MAX_MINT_AMOUNT}`)
    }

    // Ensure keyset exists for this rune
    // Check database directly to avoid race conditions with concurrent requests
    const existingKeyset = await this.keyManager.getKeysetByRuneIdAndUnit(runeId, unit)

    if (!existingKeyset) {
      // Try to generate keyset, but handle duplicate key errors gracefully
      // since multiple concurrent requests might try to create the same keyset
      try {
        await this.keyManager.generateKeyset(runeId, unit)
        logger.info({ runeId, unit }, 'Generated new keyset for rune')
      } catch (error) {
        // If duplicate key error (23505), the keyset already exists - this is fine
        if (hasErrorCode(error, '23505')) {
          logger.debug({ runeId, unit }, 'Keyset already exists (race condition), continuing')
        } else {
          // Re-throw other errors
          throw error
        }
      }
    }

    // Generate quote ID
    const quoteId = randomBytes(32).toString('hex')

    // Get the appropriate backend for this unit
    const backend = this.backendRegistry.getByMethod(method, unit)

    // Generate deposit address using the backend
    // Amount is already in smallest units (integer)
    const depositAddress = await backend.createDepositAddress(quoteId, BigInt(amount))

    // Set expiry (24 hours from now)
    const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60

    // Save quote to database
    const quote = await this.quoteRepo.createMintQuote({
      id: quoteId,
      amount,
      unit,
      rune_id: runeId,
      method,
      request: depositAddress,
      state: 'UNPAID',
      expiry,
      pubkey,
      amount_paid: 0,
      amount_issued: 0,
    })

    logger.info({ quoteId, amount, runeId, depositAddress }, 'Mint quote created')

    return {
      quote: quote.id,
      request: quote.request,
      state: quote.state,
      expiry: quote.expiry,
      amount: quote.amount,
      unit: quote.unit,
      pubkey: quote.pubkey,
    }
  }

  async createOnchainMintQuote(
    unit: string,
    pubkey: string,
    runeId?: string,
    amount: number = 0
  ): Promise<OnchainMintQuoteResponse> {
    this.validatePubkey(pubkey)
    if (!Number.isInteger(amount) || amount < 0) {
      throw new MintError('Onchain mint quote amount must be a non-negative integer', 20010)
    }
    if (unit !== 'unit' && amount <= 0) {
      throw new MintError('Onchain mint quote amount is required for this unit', 20010)
    }
    const effectiveRuneId = this.defaultRuneIdForUnit(unit, runeId)
    await this.ensureKeyset(effectiveRuneId, unit)

    const quoteId = randomBytes(32).toString('hex')
    const backend = this.backendRegistry.getByMethod('onchain', unit)
    const quoteAmount = unit === 'unit' ? 0 : amount
    const depositAddress = await backend.createDepositAddress(quoteId, BigInt(quoteAmount))
    const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60

    const quote = await this.quoteRepo.createMintQuote({
      id: quoteId,
      amount: quoteAmount,
      unit,
      rune_id: effectiveRuneId,
      method: 'onchain',
      request: depositAddress,
      state: 'UNPAID',
      expiry,
      pubkey,
      amount_paid: 0,
      amount_issued: 0,
    })

    logger.info({ quoteId, amount: quoteAmount, requestedAmount: amount, unit, depositAddress }, 'Onchain mint quote created')

    return this.toOnchainMintQuoteResponse(quote)
  }

  /**
   * Get mint quote status
   * Also checks the blockchain for deposit confirmation
   */
  async getMintQuote(quoteId: string): Promise<MintQuoteResponse | OnchainMintQuoteResponse> {
    const quote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)

    if (quote.method === 'onchain') {
      return this.getOnchainMintQuote(quoteId)
    }

    // If quote is still UNPAID, check for deposits
    if (quote.state === 'UNPAID') {
      try {
        const backend = this.backendRegistry.getByMethod(quote.method, quote.unit)
        // Pass expected amount for exact UTXO matching (helps BTC backend with shared addresses)
        const depositStatus = await backend.checkDeposit(
          quoteId,
          quote.request,
          false,
          BigInt(quote.amount)
        )

        if (depositStatus.confirmed) {
          const receivedAmount = depositStatus.amount ?? BigInt(quote.amount)
          // CRITICAL: Verify actual Runes amount received matches quote amount
          if (depositStatus.amount !== undefined) {
            const expectedAmount = BigInt(quote.amount)

            if (receivedAmount !== expectedAmount) {
              logger.warn(
                {
                  quoteId,
                  expectedAmount: expectedAmount.toString(),
                  receivedAmount: receivedAmount.toString(),
                  difference: (receivedAmount - expectedAmount).toString(),
                },
                'Deposit amount mismatch - quote will remain UNPAID'
              )
              // Don't mark as PAID if amount doesn't match
              return {
                quote: quote.id,
                request: quote.request,
                state: 'UNPAID',
                expiry: quote.expiry,
                amount: quote.amount,
                unit: quote.unit,
              }
            }
          }

          // Update quote to PAID with txid/vout for later verification
          const claimed = await this.claimDepositForQuote(quote, depositStatus, receivedAmount)
          if (!claimed) {
            logger.warn(
              { quoteId, txid: depositStatus.txid, vout: depositStatus.vout },
              'Deposit already claimed by another quote'
            )
            return {
              quote: quote.id,
              request: quote.request,
              state: 'UNPAID',
              expiry: quote.expiry,
              amount: quote.amount,
              unit: quote.unit,
            }
          }
          quote.state = 'PAID'
          notificationBus.publish('bolt11_mint_quote', {
            quote: quote.id,
            request: quote.request,
            state: quote.state,
            expiry: quote.expiry,
            amount: quote.amount,
            unit: quote.unit,
          })

          logger.info(
            {
              quoteId,
              txid: depositStatus.txid,
              vout: depositStatus.vout,
              confirmations: depositStatus.confirmations,
            },
            'Deposit confirmed, quote marked as PAID'
          )
        }
      } catch (error) {
        // Log error but don't fail the request
        // This allows the quote status to be returned even if blockchain check fails
        logger.warn({ error, quoteId }, 'Failed to check deposit status')
      }
    }

    return {
      quote: quote.id,
      request: quote.request,
      state: quote.state,
      expiry: quote.expiry,
      amount: quote.amount,
      unit: quote.unit,
    }
  }

  /**
   * Mint tokens after quote is paid
   */
  async mintTokens(
    quoteId: string,
    outputs: BlindedMessage[],
    signature?: string
  ): Promise<{ signatures: BlindSignature[] }> {
    logger.info({ quoteId, outputCount: outputs.length }, 'Minting tokens')

    // 1. Get quote
    const quote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)

    if (quote.method === 'onchain') {
      this.verifyMintQuoteSignature(quoteId, outputs, quote.pubkey, signature)
      return this.mintOnchainTokens(quoteId, outputs)
    }

    this.verifyMintQuoteSignature(quoteId, outputs, quote.pubkey, signature)

    // 2. ALWAYS verify deposit on-chain before issuing tokens
    // This prevents:
    // - Issuing tokens before deposit is confirmed
    // - Chain reorgs removing the deposit after quote marked PAID
    // - Race conditions between marking PAID and minting tokens
    logger.info(
      {
        quoteId,
        currentState: quote.state,
        quoteTxid: quote.txid,
        quoteVout: quote.vout,
        requiredConfirmations: env.MINT_CONFIRMATIONS,
      },
      'Verifying deposit on-chain before minting'
    )

    // Get the appropriate backend for this quote's unit
    const backend = this.backendRegistry.getByMethod(quote.method, quote.unit)

    // If quote has txid/vout stored, verify that specific UTXO directly
    // Otherwise fall back to scanning all UTXOs (for old quotes without txid/vout)
    let depositStatus
    if (quote.txid && quote.vout !== undefined) {
      // Verify the specific UTXO that was recorded when quote was marked PAID
      depositStatus = await backend.verifySpecificDeposit(quoteId, quote.txid, quote.vout)
    } else {
      // Fall back to scanning all UTXOs with expected amount for exact matching
      depositStatus = await backend.checkDeposit(quoteId, quote.request, true, BigInt(quote.amount))
    }

    // Check confirmations meet minimum threshold
    if (!depositStatus.confirmed || (depositStatus.confirmations ?? 0) < env.MINT_CONFIRMATIONS) {
      logger.warn(
        {
          quoteId,
          confirmations: depositStatus.confirmations ?? 0,
          required: env.MINT_CONFIRMATIONS,
        },
        'Deposit not yet confirmed with required confirmations - refusing to mint'
      )
      throw new Error(
        `Deposit requires ${env.MINT_CONFIRMATIONS} confirmations (current: ${depositStatus.confirmations ?? 0})`
      )
    }

    // CRITICAL: Verify actual Runes amount received matches quote amount
    // This prevents exploitation where user requests 1000 but only sends 100
    const depositAmount =
      depositStatus.amount ?? (quote.method === 'bolt11' ? BigInt(quote.amount) : undefined)

    if (depositAmount !== undefined) {
      const receivedAmount = depositAmount
      const expectedAmount = BigInt(quote.amount)

      if (receivedAmount !== expectedAmount) {
        logger.error(
          {
            quoteId,
            expectedAmount: expectedAmount.toString(),
            receivedAmount: receivedAmount.toString(),
            difference: (receivedAmount - expectedAmount).toString(),
          },
          'SECURITY: Deposit amount mismatch - refusing to mint'
        )
        throw new AmountMismatchError(Number(expectedAmount), Number(receivedAmount))
      }

      logger.info(
        { quoteId, amount: receivedAmount.toString(), confirmations: depositStatus.confirmations },
        'Deposit verified: amount matches and has required confirmations'
      )

      const claimed = await this.claimDepositForQuote(quote, depositStatus, receivedAmount)
      if (!claimed) {
        logger.error(
          { quoteId, txid: depositStatus.txid, vout: depositStatus.vout },
          'SECURITY: Deposit already claimed by another quote - refusing to mint'
        )
        throw new Error('Deposit already claimed by another quote')
      }
    } else {
      // If amount is undefined, deposit wasn't found at all
      logger.error({ quoteId }, 'SECURITY: Deposit not found on-chain - refusing to mint')
      throw new Error('Deposit not found on-chain')
    }

    // Update quote to PAID if not already (idempotent)
    if (quote.state !== 'PAID') {
      logger.info(
        { quoteId, txid: depositStatus.txid, confirmations: depositStatus.confirmations },
        'Quote marked as PAID'
      )
    }

    return this.quoteRepo.withMintQuoteLock(quoteId, async (lockedQuote, client) => {
      if (lockedQuote.state === 'ISSUED') {
        throw new Error('Quote already issued - tokens already minted')
      }

      const totalOutput = outputs.reduce((sum, o) => sum + o.amount, 0)
      if (totalOutput !== lockedQuote.amount) {
        throw new AmountMismatchError(lockedQuote.amount, totalOutput)
      }

      await this.ensureOutputsUseUnit(outputs, lockedQuote.unit)

      const signatures = await this.mintCrypto.signBlindedMessages(outputs)
      await this.signatureRepo?.saveMany(outputs, signatures, client)
      await this.quoteRepo.markMintQuoteIssued(quoteId, client)

      logger.info({ quoteId, signatureCount: signatures.length }, 'Tokens minted successfully')

      return { signatures }
    })
  }

  private async mintOnchainTokens(
    quoteId: string,
    outputs: BlindedMessage[]
  ): Promise<{ signatures: BlindSignature[] }> {
    const preflightQuote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)
    const totalOutput = outputs.reduce((sum, o) => sum + o.amount, 0)

    if (totalOutput <= 0) {
      throw new AmountMismatchError(1, totalOutput)
    }

    if (preflightQuote.unit === 'unit' && preflightQuote.amount <= 0) {
      const backend = this.backendRegistry.getByMethod(preflightQuote.method, preflightQuote.unit)
      if (this.isAmbiguousSharedUnitQuote(preflightQuote, backend)) {
        throw new MintError('Amountless shared-address UNIT mint quote is ambiguous', 20011)
      }

      const depositStatus = await backend.checkDeposit(
        quoteId,
        preflightQuote.request,
        true,
        BigInt(totalOutput)
      )

      if (
        !depositStatus.confirmed ||
        depositStatus.amount === undefined ||
        depositStatus.txid === undefined ||
        depositStatus.vout === undefined
      ) {
        throw new Error('Deposit not found on-chain for requested mint amount')
      }

      if (depositStatus.amount !== BigInt(totalOutput)) {
        throw new AmountMismatchError(totalOutput, Number(depositStatus.amount))
      }

      const claimed = await this.claimDepositForQuote(
        preflightQuote,
        depositStatus,
        depositStatus.amount
      )
      if (!claimed) {
        logger.error(
          { quoteId, txid: depositStatus.txid, vout: depositStatus.vout },
          'SECURITY: Deposit already claimed by another quote - refusing to mint'
        )
        throw new Error('Deposit already claimed by another quote')
      }
    } else {
      await this.getOnchainMintQuote(quoteId)
    }

    return this.quoteRepo.withMintQuoteLock(quoteId, async (quote, client) => {
      const availableAmount = quote.amount_paid - quote.amount_issued

      if (quote.amount > 0 && totalOutput !== quote.amount) {
        throw new AmountMismatchError(quote.amount, totalOutput)
      }

      if (quote.unit === 'unit' && quote.amount <= 0 && totalOutput !== availableAmount) {
        throw new AmountMismatchError(availableAmount, totalOutput)
      }

      if (totalOutput > availableAmount) {
        throw new AmountMismatchError(availableAmount, totalOutput)
      }

      await this.ensureOutputsUseUnit(outputs, quote.unit)
      const signatures = await this.mintCrypto.signBlindedMessages(outputs)
      await this.signatureRepo?.saveMany(outputs, signatures, client)
      await this.quoteRepo.incrementMintQuoteIssued(quoteId, totalOutput, client)

      logger.info(
        { quoteId, totalOutput, signatureCount: signatures.length },
        'Onchain tokens minted'
      )

      return { signatures }
    })
  }

  private async getOnchainMintQuote(quoteId: string): Promise<OnchainMintQuoteResponse> {
    const quote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)
    const backend = this.backendRegistry.getByMethod(quote.method, quote.unit)

    try {
      if (this.isAmbiguousSharedUnitQuote(quote, backend)) {
        logger.warn({ quoteId }, 'Skipping ambiguous shared-address UNIT quote without amount')
        return this.toOnchainMintQuoteResponse(quote)
      }

      const expectedAmount = quote.amount > 0 ? BigInt(quote.amount) : undefined
      const depositStatus = await backend.checkDeposit(
        quoteId,
        quote.request,
        true,
        expectedAmount
      )
      if (depositStatus.confirmed && depositStatus.amount !== undefined) {
        if (depositStatus.txid && depositStatus.vout !== undefined) {
          const claimed = await this.claimDepositForQuote(
            quote,
            depositStatus,
            depositStatus.amount
          )
          if (claimed) {
            const updatedQuote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)
            quote.amount_paid = updatedQuote.amount_paid
            quote.amount_issued = updatedQuote.amount_issued
            quote.state = updatedQuote.state
            quote.txid = updatedQuote.txid
            quote.vout = updatedQuote.vout
          }
        } else {
          const amountPaid = Number(depositStatus.amount)
          await this.quoteRepo.updateMintQuotePayment(
            quoteId,
            amountPaid,
            depositStatus.txid,
            depositStatus.vout
          )

          quote.amount_paid = amountPaid
          quote.txid = depositStatus.txid
          quote.vout = depositStatus.vout
        }
      }
    } catch (error) {
      logger.warn({ error, quoteId }, 'Failed to check onchain mint quote status')
    }

    return this.toOnchainMintQuoteResponse(quote)
  }

  private isAmbiguousSharedUnitQuote(
    quote: { unit: string; amount: number; request: string },
    backend: unknown
  ): boolean {
    return (
      quote.unit === 'unit' &&
      quote.amount <= 0 &&
      typeof (backend as { isCanonicalDepositAddress?: unknown }).isCanonicalDepositAddress ===
        'function' &&
      (backend as { isCanonicalDepositAddress: (address: string) => boolean })
        .isCanonicalDepositAddress(quote.request)
    )
  }

  private toOnchainMintQuoteResponse(quote: {
    id: string
    request: string
    unit: string
    expiry: number
    pubkey?: string
    amount_paid: number
    amount_issued: number
  }): OnchainMintQuoteResponse {
    if (!quote.pubkey) {
      throw new MintError('Onchain mint quote missing pubkey', 20009)
    }

    return {
      quote: quote.id,
      request: quote.request,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      amount_paid: quote.amount_paid,
      amount_issued: quote.amount_issued,
    }
  }

  private async claimDepositForQuote(
    quote: {
      id: string
      method: string
      unit: string
    },
    depositStatus: {
      amount?: bigint
      txid?: string
      vout?: number
    },
    amount: bigint
  ): Promise<boolean> {
    if (!depositStatus.txid || depositStatus.vout === undefined) {
      if (quote.method === 'onchain') {
        await this.quoteRepo.updateMintQuotePayment(
          quote.id,
          Number(amount),
          depositStatus.txid,
          depositStatus.vout
        )
      } else {
        await this.quoteRepo.updateMintQuoteState(
          quote.id,
          'PAID',
          depositStatus.txid,
          depositStatus.vout
        )
      }
      return true
    }

    return this.quoteRepo.claimMintDeposit({
      quoteId: quote.id,
      method: quote.method,
      unit: quote.unit,
      amount,
      txid: depositStatus.txid,
      vout: depositStatus.vout,
      creditMode: quote.method === 'onchain' ? 'increment-paid' : 'set-paid',
    })
  }

  private async ensureKeyset(runeId: string, unit: string): Promise<void> {
    const existingKeyset = await this.keyManager.getKeysetByRuneIdAndUnit(runeId, unit)

    if (existingKeyset) {
      return
    }

    try {
      await this.keyManager.generateKeyset(runeId, unit)
      logger.info({ runeId, unit }, 'Generated new keyset')
    } catch (error) {
      if (hasErrorCode(error, '23505')) {
        logger.debug({ runeId, unit }, 'Keyset already exists (race condition), continuing')
        return
      }

      throw error
    }
  }

  private async ensureOutputsUseUnit(outputs: BlindedMessage[], unit: string): Promise<void> {
    const activeKeysets = await this.keyManager.getActiveKeysetsByUnit(unit)
    const keysetIds = new Set(activeKeysets.map((keyset) => keyset.id))

    for (const output of outputs) {
      if (!keysetIds.has(output.id)) {
        throw new MintError(`Output keyset does not match quote unit`, 20001, `id=${output.id}`)
      }
    }
  }

  private verifyMintQuoteSignature(
    quoteId: string,
    outputs: BlindedMessage[],
    pubkey?: string,
    signature?: string
  ): void {
    if (!pubkey) {
      return
    }

    if (!signature) {
      throw new MintError('Mint quote requires a valid signature', 20008)
    }

    let isValid = false
    try {
      const blindedMessages = outputs as unknown as Parameters<
        typeof cashuVerifyMintQuoteSignature
      >[2]
      isValid = cashuVerifyMintQuoteSignature(pubkey, quoteId, blindedMessages, signature)
    } catch {
      isValid = false
    }

    if (!isValid) {
      throw new MintError('Mint quote requires a valid signature', 20008)
    }
  }

  private validatePubkey(pubkey: string): void {
    if (!/^(02|03)[0-9a-fA-F]{64}$/.test(pubkey)) {
      throw new MintError('Mint quote requires a valid pubkey', 20009)
    }
  }

  private defaultRuneIdForUnit(unit: string, runeId?: string): string {
    if (runeId) {
      return runeId
    }

    if (unit === 'unit') {
      const supportedRuneId = env.SUPPORTED_RUNES_ARRAY[0]
      if (!supportedRuneId) {
        throw new MintError('Rune ID required for unit', 20010)
      }

      return supportedRuneId
    }

    return 'btc:0'
  }
}
