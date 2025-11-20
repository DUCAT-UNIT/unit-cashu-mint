import { randomBytes } from 'crypto'
import { MintCrypto } from '../crypto/MintCrypto.js'
import { KeyManager } from '../crypto/KeyManager.js'
import { QuoteRepository } from '../../database/repositories/QuoteRepository.js'
import { BlindedMessage, BlindSignature, MintQuoteResponse } from '../../types/cashu.js'
import {
  AmountMismatchError,
} from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { RunesBackend } from '../../runes/RunesBackend.js'

export class MintService {
  constructor(
    private mintCrypto: MintCrypto,
    private quoteRepo: QuoteRepository,
    private runesBackend: RunesBackend,
    private keyManager: KeyManager
  ) {}

  /**
   * Create a mint quote for Runes deposit
   */
  async createMintQuote(
    amount: number,
    unit: string,
    runeId: string
  ): Promise<MintQuoteResponse> {
    // Validate amount
    if (amount < env.MIN_MINT_AMOUNT || amount > env.MAX_MINT_AMOUNT) {
      throw new Error(
        `Amount must be between ${env.MIN_MINT_AMOUNT} and ${env.MAX_MINT_AMOUNT}`
      )
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
      } catch (error: any) {
        // If duplicate key error (23505), the keyset already exists - this is fine
        if (error?.code === '23505') {
          logger.debug({ runeId, unit }, 'Keyset already exists (race condition), continuing')
        } else {
          // Re-throw other errors
          throw error
        }
      }
    }

    // Generate quote ID
    const quoteId = randomBytes(32).toString('hex')

    // Convert amount to smallest unit (multiply by 100 for Runes 2 decimal places)
    // e.g., 256 UNIT → 25600 in smallest units
    const amountInt = Math.round(amount * 100)

    // Generate deposit address using Runes backend
    const depositAddress = await this.runesBackend.createDepositAddress(
      quoteId,
      BigInt(amountInt),
      runeId
    )

    // Set expiry (24 hours from now)
    const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60

    // Save quote to database
    const quote = await this.quoteRepo.createMintQuote({
      id: quoteId,
      amount: amountInt,
      unit,
      rune_id: runeId,
      request: depositAddress,
      state: 'UNPAID',
      expiry,
    })

    logger.info({ quoteId, amount: amountInt, runeId, depositAddress }, 'Mint quote created')

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
   * Get mint quote status
   * Also checks the blockchain for deposit confirmation
   */
  async getMintQuote(quoteId: string): Promise<MintQuoteResponse> {
    const quote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)

    // If quote is still UNPAID, check for deposits
    if (quote.state === 'UNPAID') {
      try {
        const depositStatus = await this.runesBackend.checkDeposit(quoteId, quote.request)

        if (depositStatus.confirmed) {
          // CRITICAL: Verify actual Runes amount received matches quote amount
          if (depositStatus.amount !== undefined) {
            const receivedAmount = depositStatus.amount
            const expectedAmount = BigInt(quote.amount)

            if (receivedAmount !== expectedAmount) {
              logger.warn(
                {
                  quoteId,
                  expectedAmount: expectedAmount.toString(),
                  receivedAmount: receivedAmount.toString(),
                  difference: (receivedAmount - expectedAmount).toString()
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

          // Update quote to PAID
          await this.quoteRepo.updateMintQuoteState(quoteId, 'PAID')
          quote.state = 'PAID'

          logger.info(
            { quoteId, txid: depositStatus.txid, confirmations: depositStatus.confirmations },
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
    outputs: BlindedMessage[]
  ): Promise<{ signatures: BlindSignature[] }> {
    logger.info({ quoteId, outputCount: outputs.length }, 'Minting tokens')

    // 1. Get quote
    const quote = await this.quoteRepo.findMintQuoteByIdOrThrow(quoteId)

    // 2. ALWAYS verify deposit on-chain before issuing tokens
    // This prevents:
    // - Issuing tokens before deposit is confirmed
    // - Chain reorgs removing the deposit after quote marked PAID
    // - Race conditions between marking PAID and minting tokens
    logger.info(
      { quoteId, currentState: quote.state, requiredConfirmations: env.MINT_CONFIRMATIONS },
      'Verifying deposit on-chain before minting'
    )

    const depositStatus = await this.runesBackend.checkDeposit(quoteId, quote.request)

    // Check confirmations meet minimum threshold
    if (!depositStatus.confirmed || (depositStatus.confirmations ?? 0) < env.MINT_CONFIRMATIONS) {
      logger.warn(
        {
          quoteId,
          confirmations: depositStatus.confirmations ?? 0,
          required: env.MINT_CONFIRMATIONS
        },
        'Deposit not yet confirmed with required confirmations - refusing to mint'
      )
      throw new Error(
        `Deposit requires ${env.MINT_CONFIRMATIONS} confirmations (current: ${depositStatus.confirmations ?? 0})`
      )
    }

    // CRITICAL: Verify actual Runes amount received matches quote amount
    // This prevents exploitation where user requests 1000 but only sends 100
    if (depositStatus.amount !== undefined) {
      const receivedAmount = depositStatus.amount
      const expectedAmount = BigInt(quote.amount)

      if (receivedAmount !== expectedAmount) {
        logger.error(
          {
            quoteId,
            expectedAmount: expectedAmount.toString(),
            receivedAmount: receivedAmount.toString(),
            difference: (receivedAmount - expectedAmount).toString()
          },
          'SECURITY: Deposit amount mismatch - refusing to mint'
        )
        throw new AmountMismatchError(Number(expectedAmount), Number(receivedAmount))
      }

      logger.info(
        { quoteId, amount: receivedAmount.toString(), confirmations: depositStatus.confirmations },
        'Deposit verified: amount matches and has required confirmations'
      )
    } else {
      // If amount is undefined, deposit wasn't found at all
      logger.error({ quoteId }, 'SECURITY: Deposit not found on-chain - refusing to mint')
      throw new Error('Deposit not found on-chain')
    }

    // Update quote to PAID if not already (idempotent)
    if (quote.state !== 'PAID') {
      await this.quoteRepo.updateMintQuoteState(quoteId, 'PAID')
      logger.info(
        { quoteId, txid: depositStatus.txid, confirmations: depositStatus.confirmations },
        'Quote marked as PAID'
      )
    }

    // 4. Check if already issued
    if (quote.state === 'ISSUED') {
      throw new Error('Quote already issued - tokens already minted')
    }

    // 5. Verify output amounts sum to quote amount
    const totalOutput = outputs.reduce((sum, o) => sum + o.amount, 0)
    if (totalOutput !== quote.amount) {
      throw new AmountMismatchError(quote.amount, totalOutput)
    }

    // 6. Sign blinded messages ONLY after deposit confirmed
    const signatures = await this.mintCrypto.signBlindedMessages(outputs)

    // 7. Mark quote as issued
    await this.quoteRepo.updateMintQuoteState(quoteId, 'ISSUED')

    logger.info({ quoteId, signatureCount: signatures.length }, 'Tokens minted successfully')

    return { signatures }
  }
}
