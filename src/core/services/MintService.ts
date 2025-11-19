import { randomBytes } from 'crypto'
import { MintCrypto } from '../crypto/MintCrypto.js'
import { QuoteRepository } from '../../database/repositories/QuoteRepository.js'
import { BlindedMessage, BlindSignature, MintQuoteResponse } from '../../types/cashu.js'
import {
  QuoteNotPaidError,
  AmountMismatchError,
} from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { RunesBackend } from '../../runes/RunesBackend.js'

export class MintService {
  constructor(
    private mintCrypto: MintCrypto,
    private quoteRepo: QuoteRepository,
    private runesBackend: RunesBackend
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

    // Generate quote ID
    const quoteId = randomBytes(32).toString('hex')

    // Generate deposit address using Runes backend
    const depositAddress = await this.runesBackend.createDepositAddress(
      quoteId,
      BigInt(amount),
      runeId
    )

    // Set expiry (24 hours from now)
    const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60

    // Save quote to database
    const quote = await this.quoteRepo.createMintQuote({
      id: quoteId,
      amount,
      unit,
      rune_id: runeId,
      request: depositAddress,
      state: 'UNPAID',
      expiry,
    })

    logger.info({ quoteId, amount, runeId, depositAddress }, 'Mint quote created')

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

    // 2. Verify quote is paid
    if (quote.state !== 'PAID') {
      throw new QuoteNotPaidError(quoteId)
    }

    // Note: If already issued, the state check above (quote.state !== 'PAID') would have caught it
    // since the state progression is UNPAID -> PAID -> ISSUED

    // 4. Verify output amounts sum to quote amount
    const totalOutput = outputs.reduce((sum, o) => sum + o.amount, 0)
    if (totalOutput !== quote.amount) {
      throw new AmountMismatchError(quote.amount, totalOutput)
    }

    // 5. Sign blinded messages
    const signatures = this.mintCrypto.signBlindedMessages(outputs)

    // 6. Mark quote as issued
    await this.quoteRepo.updateMintQuoteState(quoteId, 'ISSUED')

    logger.info({ quoteId, signatureCount: signatures.length }, 'Tokens minted successfully')

    return { signatures }
  }
}
