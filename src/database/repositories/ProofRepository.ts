import pg from 'pg'
import { query, transaction } from '../db.js'
import { ProofRecord, ProofRow, proofFromRow } from '../../core/models/Proof.js'
import { Proof } from '../../types/cashu.js'
import { ProofAlreadySpentError } from '../../utils/errors.js'

export class ProofRepository {
  /**
   * Check if proofs are spent (by Y values)
   * Returns array of Y values that are already spent
   */
  async checkSpent(Y_values: string[], client?: pg.PoolClient): Promise<string[]> {
    if (client) {
      const result = await client.query<{ y: string }>(
        `SELECT Y FROM proofs WHERE Y = ANY($1) AND state != 'UNSPENT'`,
        [Y_values]
      )
      return result.rows.map((r: { y: string }) => r.y)
    } else {
      const result = await query<{ y: string }>(
        `SELECT Y FROM proofs WHERE Y = ANY($1) AND state != 'UNSPENT'`,
        [Y_values]
      )
      return result.rows.map((r: { y: string }) => r.y)
    }
  }

  /**
   * Mark proofs as spent atomically
   * Throws if any proof is already spent
   */
  async markSpent(
    proofs: Proof[],
    Y_values: string[],
    transactionId: string
  ): Promise<void> {
    await transaction(async (client) => {
      // Check if any are already spent
      const spent = await this.checkSpent(Y_values, client)
      if (spent.length > 0) {
        throw new ProofAlreadySpentError(spent[0])
      }

      // Insert all proofs as spent
      const values = proofs.map((p, i) => ({
        Y: Y_values[i],
        keyset_id: p.id,
        amount: p.amount,
        secret: p.secret,
        C: p.C,
        witness: p.witness ? JSON.stringify(p.witness) : null,
        state: 'SPENT',
        spent_at: Date.now(),
        transaction_id: transactionId,
      }))

      for (const v of values) {
        await client.query(
          `
          INSERT INTO proofs (Y, keyset_id, amount, secret, C, witness, state, spent_at, transaction_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
          [
            v.Y,
            v.keyset_id,
            v.amount,
            v.secret,
            v.C,
            v.witness,
            v.state,
            v.spent_at,
            v.transaction_id,
          ]
        )
      }
    })
  }

  /**
   * Find proof by Y (hash_to_curve(secret))
   */
  async findByY(Y: string): Promise<ProofRecord | null> {
    const result = await query<ProofRow>('SELECT * FROM proofs WHERE Y = $1', [Y])

    if (result.rows.length === 0) {
      return null
    }

    return proofFromRow(result.rows[0])
  }

  /**
   * Find proofs by secret
   */
  async findBySecret(secret: string): Promise<ProofRecord | null> {
    const result = await query<ProofRow>('SELECT * FROM proofs WHERE secret = $1', [secret])

    if (result.rows.length === 0) {
      return null
    }

    return proofFromRow(result.rows[0])
  }

  /**
   * Find all spent proofs for a transaction
   */
  async findByTransactionId(transactionId: string): Promise<ProofRecord[]> {
    const result = await query<ProofRow>(
      'SELECT * FROM proofs WHERE transaction_id = $1 ORDER BY spent_at',
      [transactionId]
    )

    return result.rows.map(proofFromRow)
  }

  /**
   * Get count of spent proofs
   */
  async getSpentCount(): Promise<number> {
    const result = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM proofs WHERE state = 'SPENT'"
    )
    return parseInt(result.rows[0].count)
  }

  /**
   * Get total amount of spent proofs
   */
  async getSpentAmount(): Promise<number> {
    const result = await query<{ sum: string }>(
      "SELECT SUM(amount) as sum FROM proofs WHERE state = 'SPENT'"
    )
    return parseInt(result.rows[0].sum || '0')
  }

  /**
   * Check state of proofs by Y values (NUT-07)
   * Returns array of {Y, state, witness} for each Y value
   * If Y is not found in database, state is 'UNSPENT'
   */
  async checkState(Y_values: string[]): Promise<Array<{ Y: string; state: string; witness: string | null }>> {
    if (Y_values.length === 0) {
      return []
    }

    const result = await query<{ y: string; state: string; witness: string | null }>(
      'SELECT Y, state, witness FROM proofs WHERE Y = ANY($1)',
      [Y_values]
    )

    // Create a map of found proofs
    const foundMap = new Map(result.rows.map(r => [r.y, { state: r.state, witness: r.witness }]))

    // Return results in same order as input, with UNSPENT for missing Y values
    return Y_values.map(Y => ({
      Y,
      state: foundMap.get(Y)?.state || 'UNSPENT',
      witness: foundMap.get(Y)?.witness || null
    }))
  }

  /**
   * Delete proofs by transaction ID (to revert a failed melt)
   * This effectively marks them as unspent since they won't be in the database
   */
  async deleteByTransactionId(transactionId: string): Promise<number> {
    const result = await query(
      'DELETE FROM proofs WHERE transaction_id = $1',
      [transactionId]
    )
    return result.rowCount || 0
  }
}
