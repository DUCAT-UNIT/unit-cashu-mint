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
      INSERT INTO mint_quotes (
        id, amount, unit, rune_id, method, request, state, expiry, created_at,
        pubkey, amount_paid, amount_issued
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `,
      [
        quote.id,
        quote.amount,
        quote.unit,
        quote.rune_id,
        quote.method ?? 'unit',
        quote.request,
        quote.state,
        quote.expiry,
        created_at,
        quote.pubkey ?? null,
        quote.amount_paid ?? 0,
        quote.amount_issued ?? 0,
      ]
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
    const paid_at = state === 'PAID' ? Date.now() : undefined

    await query(
      `
      UPDATE mint_quotes
      SET state = $1,
          paid_at = COALESCE($2, paid_at),
          txid = COALESCE($3, txid),
          vout = COALESCE($4, vout)
      WHERE id = $5
    `,
      [state, paid_at ?? null, txid ?? null, vout ?? null, id]
    )
  }

  async updateMintQuotePayment(
    id: string,
    amountPaid: number,
    txid?: string,
    vout?: number
  ): Promise<void> {
    await query(
      `
      UPDATE mint_quotes
      SET amount_paid = $1,
          txid = COALESCE($2, txid),
          vout = COALESCE($3, vout),
          state = CASE WHEN $1 > amount_issued THEN 'PAID' ELSE state END,
          paid_at = CASE WHEN $1 > amount_issued THEN COALESCE(paid_at, $4) ELSE paid_at END
      WHERE id = $5
    `,
      [amountPaid, txid ?? null, vout ?? null, Date.now(), id]
    )
  }

  async incrementMintQuoteIssued(id: string, amount: number): Promise<void> {
    await query(
      `
      UPDATE mint_quotes
      SET amount_issued = amount_issued + $1,
          state = CASE WHEN amount_issued + $1 >= amount_paid THEN 'ISSUED' ELSE state END
      WHERE id = $2
    `,
      [amount, id]
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
      INSERT INTO melt_quotes (
        id, amount, fee_reserve, unit, rune_id, method, request, state, expiry,
        created_at, fee, estimated_blocks, outpoint
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `,
      [
        quote.id,
        quote.amount,
        quote.fee_reserve,
        quote.unit,
        quote.rune_id,
        quote.method ?? 'unit',
        quote.request,
        quote.state,
        quote.expiry,
        created_at,
        quote.fee ?? null,
        quote.estimated_blocks ?? null,
        quote.outpoint ?? null,
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

  async findSettledMeltQuoteByRequest(
    request: string,
    method: string,
    unit: string,
    excludeId?: string
  ): Promise<MeltQuote | null> {
    const result = await query<MeltQuoteRow>(
      `
      SELECT *
      FROM melt_quotes
      WHERE request = $1
        AND method = $2
        AND unit = $3
        AND state IN ($4, $5)
        AND ($6::text IS NULL OR id <> $6)
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [request, method, unit, 'PENDING', 'PAID', excludeId ?? null]
    )

    if (result.rows.length === 0) {
      return null
    }

    return meltQuoteFromRow(result.rows[0])
  }

  async updateMeltQuoteState(
    id: string,
    state: MeltQuoteState,
    txid?: string,
    fee_paid?: number,
    outpoint?: string
  ): Promise<void> {
    const paid_at = state === 'PAID' ? Date.now() : undefined

    await query(
      `
      UPDATE melt_quotes
      SET state = $1,
          paid_at = COALESCE($2, paid_at),
          txid = COALESCE($3, txid),
          outpoint = COALESCE($5, outpoint),
          fee_paid = COALESCE($4, fee_paid)
      WHERE id = $6
    `,
      [state, paid_at ?? null, txid ?? null, fee_paid ?? null, outpoint ?? null, id]
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
