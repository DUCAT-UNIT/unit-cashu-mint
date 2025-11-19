import { query } from '../db.js'
import {
  MintQuote,
  MintQuoteRow,
  mintQuoteFromRow,
  MeltQuote,
  MeltQuoteRow,
  meltQuoteFromRow,
} from '../../core/models/Quote.js'
import { MintQuoteState, MeltQuoteState } from '../../types/cashu.js'
import { QuoteNotFoundError } from '../../utils/errors.js'

export class QuoteRepository {
  // Mint Quotes
  async createMintQuote(quote: Omit<MintQuote, 'created_at'>): Promise<MintQuote> {
    const created_at = Date.now()
    const result = await query<MintQuoteRow>(
      `
      INSERT INTO mint_quotes (id, amount, unit, rune_id, request, state, expiry, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
      [quote.id, quote.amount, quote.unit, quote.rune_id, quote.request, quote.state, quote.expiry, created_at]
    )

    return mintQuoteFromRow(result.rows[0])
  }

  async findMintQuoteById(id: string): Promise<MintQuote | null> {
    const result = await query<MintQuoteRow>('SELECT * FROM mint_quotes WHERE id = $1', [id])

    if (result.rows.length === 0) {
      return null
    }

    return mintQuoteFromRow(result.rows[0])
  }

  async findMintQuoteByIdOrThrow(id: string): Promise<MintQuote> {
    const quote = await this.findMintQuoteById(id)
    if (!quote) {
      throw new QuoteNotFoundError(id)
    }
    return quote
  }

  async findMintQuoteByRequest(request: string): Promise<MintQuote | null> {
    const result = await query<MintQuoteRow>('SELECT * FROM mint_quotes WHERE request = $1', [
      request,
    ])

    if (result.rows.length === 0) {
      return null
    }

    return mintQuoteFromRow(result.rows[0])
  }

  async updateMintQuoteState(
    id: string,
    state: MintQuoteState,
    txid?: string,
    vout?: number
  ): Promise<void> {
    const paid_at = state === 'PAID' ? Date.now() : null

    await query(
      `
      UPDATE mint_quotes
      SET state = $1, paid_at = $2, txid = $3, vout = $4
      WHERE id = $5
    `,
      [state, paid_at, txid ?? null, vout ?? null, id]
    )
  }

  async findExpiredMintQuotes(): Promise<MintQuote[]> {
    const now = Date.now()
    const result = await query<MintQuoteRow>(
      'SELECT * FROM mint_quotes WHERE state = $1 AND expiry < $2',
      ['UNPAID', now]
    )
    return result.rows.map(mintQuoteFromRow)
  }

  async findMintQuotesByState(state: MintQuoteState, limit: number = 50): Promise<MintQuote[]> {
    const result = await query<MintQuoteRow>(
      'SELECT * FROM mint_quotes WHERE state = $1 ORDER BY created_at DESC LIMIT $2',
      [state, limit]
    )
    return result.rows.map(mintQuoteFromRow)
  }

  // Melt Quotes
  async createMeltQuote(quote: Omit<MeltQuote, 'created_at'>): Promise<MeltQuote> {
    const created_at = Date.now()
    const result = await query<MeltQuoteRow>(
      `
      INSERT INTO melt_quotes (id, amount, fee_reserve, unit, rune_id, request, state, expiry, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
      [
        quote.id,
        quote.amount,
        quote.fee_reserve,
        quote.unit,
        quote.rune_id,
        quote.request,
        quote.state,
        quote.expiry,
        created_at,
      ]
    )

    return meltQuoteFromRow(result.rows[0])
  }

  async findMeltQuoteById(id: string): Promise<MeltQuote | null> {
    const result = await query<MeltQuoteRow>('SELECT * FROM melt_quotes WHERE id = $1', [id])

    if (result.rows.length === 0) {
      return null
    }

    return meltQuoteFromRow(result.rows[0])
  }

  async findMeltQuoteByIdOrThrow(id: string): Promise<MeltQuote> {
    const quote = await this.findMeltQuoteById(id)
    if (!quote) {
      throw new QuoteNotFoundError(id)
    }
    return quote
  }

  async updateMeltQuoteState(
    id: string,
    state: MeltQuoteState,
    txid?: string,
    fee_paid?: number
  ): Promise<void> {
    const paid_at = state === 'PAID' ? Date.now() : null

    await query(
      `
      UPDATE melt_quotes
      SET state = $1, paid_at = $2, txid = $3, fee_paid = $4
      WHERE id = $5
    `,
      [state, paid_at, txid ?? null, fee_paid ?? null, id]
    )
  }

  async findExpiredMeltQuotes(): Promise<MeltQuote[]> {
    const now = Date.now()
    const result = await query<MeltQuoteRow>(
      'SELECT * FROM melt_quotes WHERE state IN ($1, $2) AND expiry < $3',
      ['UNPAID', 'PENDING', now]
    )
    return result.rows.map(meltQuoteFromRow)
  }
}
