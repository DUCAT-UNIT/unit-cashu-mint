import { Pool } from 'pg'
import { RuneUtxo } from './types.js'
import { logger } from '../utils/logger.js'

export interface MintUtxoRecord {
  txid: string
  vout: number
  rune_id: string
  amount: string // bigint as string
  address: string
  value: number // sats
  spent: boolean
  spent_in_txid?: string
  created_at: number
}

/**
 * Manages the mint's UTXO set for Runes reserves
 */
export class UtxoManager {
  constructor(private db: Pool) {}

  /**
   * Track a new UTXO in the mint's reserves
   */
  async addUtxo(utxo: RuneUtxo): Promise<void> {
    const runeIdStr = `${utxo.runeId.block}:${utxo.runeId.tx}`

    await this.db.query(
      `
      INSERT INTO mint_utxos (txid, vout, rune_id, amount, address, value, spent, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (txid, vout) DO NOTHING
    `,
      [
        utxo.txid,
        utxo.vout,
        runeIdStr,
        utxo.runeAmount.toString(),
        utxo.address,
        utxo.value,
        false,
        Date.now(),
      ]
    )

    logger.info(
      { txid: utxo.txid, vout: utxo.vout, runeAmount: utxo.runeAmount.toString() },
      'Added UTXO to mint reserves'
    )
  }

  /**
   * Mark a UTXO as spent
   */
  async markSpent(txid: string, vout: number, spentInTxid: string): Promise<void> {
    await this.db.query(
      `
      UPDATE mint_utxos
      SET spent = true, spent_in_txid = $1
      WHERE txid = $2 AND vout = $3
    `,
      [spentInTxid, txid, vout]
    )

    logger.info({ txid, vout, spentInTxid }, 'Marked UTXO as spent')
  }

  /**
   * Get all unspent UTXOs for a specific rune
   */
  async getUnspentUtxos(runeId: string): Promise<MintUtxoRecord[]> {
    const result = await this.db.query<MintUtxoRecord>(
      `
      SELECT *
      FROM mint_utxos
      WHERE rune_id = $1 AND spent = false
      ORDER BY created_at ASC
    `,
      [runeId]
    )

    return result.rows
  }

  /**
   * Get total balance for a specific rune
   */
  async getBalance(runeId: string): Promise<bigint> {
    const result = await this.db.query<{ total: string }>(
      `
      SELECT COALESCE(SUM(amount::BIGINT), 0)::TEXT as total
      FROM mint_utxos
      WHERE rune_id = $1 AND spent = false
    `,
      [runeId]
    )

    return BigInt(result.rows[0]?.total || '0')
  }

  /**
   * Get a set of spent UTXO keys for filtering
   */
  async getSpentUtxoKeys(): Promise<Set<string>> {
    const result = await this.db.query<{ txid: string; vout: number }>(
      `
      SELECT txid, vout
      FROM mint_utxos
      WHERE spent = true
    `
    )

    return new Set(result.rows.map((row) => `${row.txid}:${row.vout}`))
  }

  /**
   * Sync UTXOs from blockchain (detect new deposits)
   * This should be called periodically
   */
  async syncFromBlockchain(
    address: string,
    utxos: RuneUtxo[]
  ): Promise<{ added: number; updated: number }> {
    let added = 0
    let updated = 0

    for (const utxo of utxos) {
      try {
        // Try to insert, if already exists it will be ignored
        const result = await this.db.query(
          `
          INSERT INTO mint_utxos (txid, vout, rune_id, amount, address, value, spent, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (txid, vout) DO NOTHING
          RETURNING txid
        `,
          [
            utxo.txid,
            utxo.vout,
            `${utxo.runeId.block}:${utxo.runeId.tx}`,
            utxo.runeAmount.toString(),
            utxo.address,
            utxo.value,
            false,
            Date.now(),
          ]
        )

        if (result.rowCount && result.rowCount > 0) {
          added++
        }
      } catch (error) {
        logger.error({ error, utxo }, 'Error syncing UTXO')
      }
    }

    logger.info({ address, added, updated }, 'Synced UTXOs from blockchain')

    return { added, updated }
  }
}
