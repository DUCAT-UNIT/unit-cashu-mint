import type pg from 'pg'
import { query, transaction } from '../db.js'
import {
  MintQuote,
  MintQuoteRow,
  mintQuoteFromRow,
  MeltQuote,
  MeltQuoteRow,
  meltQuoteFromRow,
} from '../../core/models/Quote.js'
import { BlindSignature, MintQuoteState, MeltQuoteState } from '../../types/cashu.js'
import { MintError, QuoteNotFoundError } from '../../utils/errors.js'

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

  async withMintQuoteLock<T>(
    id: string,
    callback: (quote: MintQuote, client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    return transaction(async (client) => {
      const result = await client.query<MintQuoteRow>(
        'SELECT * FROM mint_quotes WHERE id = $1 FOR UPDATE',
        [id]
      )

      if (result.rows.length === 0) {
        throw new QuoteNotFoundError(id)
      }

      return callback(mintQuoteFromRow(result.rows[0]), client)
    })
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
    vout?: number,
    client?: pg.PoolClient
  ): Promise<void> {
    const paid_at = state === 'PAID' ? Date.now() : undefined
    const runQuery: (text: string, params?: unknown[]) => Promise<pg.QueryResult> = client
      ? client.query.bind(client)
      : query

    await runQuery(
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

    if (state === 'ISSUED') {
      await runQuery(
        'UPDATE mint_deposits SET issued_at = COALESCE(issued_at, $1) WHERE quote_id = $2',
        [Date.now(), id]
      )
    }
  }

  async markMintQuoteIssued(id: string, client?: pg.PoolClient): Promise<void> {
    await this.updateMintQuoteState(id, 'ISSUED', undefined, undefined, client)
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

  async claimMintDeposit(params: {
    quoteId: string
    method: string
    unit: string
    amount: bigint | number
    txid: string
    vout: number
    creditMode: 'set-paid' | 'increment-paid'
  }): Promise<boolean> {
    const amount = params.amount.toString()
    const claimedAt = Date.now()

    return transaction(async (client) => {
      const claimResult = await client.query<{ quote_id: string }>(
        `
        INSERT INTO mint_deposits (quote_id, method, unit, txid, vout, amount, claimed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (txid, vout) DO NOTHING
        RETURNING quote_id
      `,
        [params.quoteId, params.method, params.unit, params.txid, params.vout, amount, claimedAt]
      )

      if (!claimResult.rowCount) {
        const owner = await client.query<{ quote_id: string }>(
          'SELECT quote_id FROM mint_deposits WHERE txid = $1 AND vout = $2',
          [params.txid, params.vout]
        )

        if (owner.rows[0]?.quote_id !== params.quoteId) {
          return false
        }

        return true
      }

      if (params.creditMode === 'increment-paid') {
        await client.query(
          `
          UPDATE mint_quotes
          SET amount = CASE WHEN amount = 0 THEN $1 ELSE amount END,
              amount_paid = amount_paid + $1,
              txid = COALESCE(txid, $2),
              vout = COALESCE(vout, $3),
              state = CASE WHEN amount_paid + $1 > amount_issued THEN 'PAID' ELSE state END,
              paid_at = CASE WHEN amount_paid + $1 > amount_issued THEN COALESCE(paid_at, $4) ELSE paid_at END
          WHERE id = $5
        `,
          [amount, params.txid, params.vout, claimedAt, params.quoteId]
        )
      } else {
        await client.query(
          `
          UPDATE mint_quotes
          SET amount = CASE WHEN amount = 0 THEN $1 ELSE amount END,
              amount_paid = GREATEST(amount_paid, $1),
              state = CASE WHEN state = 'ISSUED' THEN state ELSE 'PAID' END,
              paid_at = COALESCE(paid_at, $2),
              txid = COALESCE(txid, $3),
              vout = COALESCE(vout, $4)
          WHERE id = $5
        `,
          [amount, claimedAt, params.txid, params.vout, params.quoteId]
        )
      }

      return true
    })
  }

  async incrementMintQuoteIssued(
    id: string,
    amount: number,
    client?: pg.PoolClient
  ): Promise<void> {
    const runQuery: (text: string, params?: unknown[]) => Promise<pg.QueryResult> = client
      ? client.query.bind(client)
      : query
    await runQuery(
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
        created_at, fee, estimated_blocks, outpoint, change
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
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
        quote.change ? JSON.stringify(quote.change) : null,
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

  async claimMeltQuotePending(id: string): Promise<MeltQuote> {
    return transaction(async (client) => {
      const result = await client.query<MeltQuoteRow>(
        'SELECT * FROM melt_quotes WHERE id = $1 FOR UPDATE',
        [id]
      )

      if (result.rows.length === 0) {
        throw new QuoteNotFoundError(id)
      }

      const quote = meltQuoteFromRow(result.rows[0])
      if (quote.state === 'PAID') {
        throw new MintError('Request already paid', 20006, 'Request already paid')
      }
      if (quote.state === 'PENDING') {
        throw new MintError('Quote is pending', 20005, 'Quote is pending')
      }

      await client.query('UPDATE melt_quotes SET state = $1 WHERE id = $2', ['PENDING', id])
      return {
        ...quote,
        state: 'PENDING',
      }
    })
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
    outpoint?: string,
    change?: BlindSignature[]
  ): Promise<void> {
    const paid_at = state === 'PAID' ? Date.now() : undefined

    await query(
      `
      UPDATE melt_quotes
      SET state = $1,
          paid_at = COALESCE($2, paid_at),
          txid = COALESCE($3, txid),
          outpoint = COALESCE($5, outpoint),
          fee_paid = COALESCE($4, fee_paid),
          change = COALESCE($6::jsonb, change)
      WHERE id = $7
    `,
      [
        state,
        paid_at ?? null,
        txid ?? null,
        fee_paid ?? null,
        outpoint ?? null,
        change ? JSON.stringify(change) : null,
        id,
      ]
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
