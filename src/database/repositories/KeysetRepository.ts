import { query } from '../db.js'
import { Keyset, KeysetRow, keysetFromRow } from '../../core/models/Keyset.js'
import { KeysetNotFoundError } from '../../utils/errors.js'

export class KeysetRepository {
  async create(keyset: Keyset): Promise<Keyset> {
    const result = await query<KeysetRow>(
      `
      INSERT INTO keysets (id, unit, rune_id, active, private_keys, public_keys, input_fee_ppk, final_expiry, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
      [
        keyset.id,
        keyset.unit,
        keyset.rune_id,
        keyset.active,
        JSON.stringify(keyset.private_keys),
        JSON.stringify(keyset.public_keys),
        keyset.input_fee_ppk ?? 0,
        keyset.final_expiry ?? null,
        keyset.created_at,
      ]
    )

    return keysetFromRow(result.rows[0])
  }

  async findById(id: string): Promise<Keyset | null> {
    const result = await query<KeysetRow>('SELECT * FROM keysets WHERE id = $1', [id])

    if (result.rows.length === 0) {
      return null
    }

    return keysetFromRow(result.rows[0])
  }

  async findByIdOrThrow(id: string): Promise<Keyset> {
    const keyset = await this.findById(id)
    if (!keyset) {
      throw new KeysetNotFoundError(id)
    }
    return keyset
  }

  async findAll(): Promise<Keyset[]> {
    const result = await query<KeysetRow>('SELECT * FROM keysets ORDER BY created_at DESC')
    return result.rows.map(keysetFromRow)
  }

  async findActive(): Promise<Keyset[]> {
    const result = await query<KeysetRow>(
      'SELECT * FROM keysets WHERE active = true ORDER BY created_at DESC'
    )
    return result.rows.map(keysetFromRow)
  }

  async findByUnit(unit: string): Promise<Keyset[]> {
    const result = await query<KeysetRow>(
      'SELECT * FROM keysets WHERE unit = $1 ORDER BY created_at DESC',
      [unit]
    )
    return result.rows.map(keysetFromRow)
  }

  async findByRuneId(runeId: string): Promise<Keyset[]> {
    const result = await query<KeysetRow>(
      'SELECT * FROM keysets WHERE rune_id = $1 ORDER BY created_at DESC',
      [runeId]
    )
    return result.rows.map(keysetFromRow)
  }

  async findActiveByUnit(unit: string): Promise<Keyset[]> {
    const result = await query<KeysetRow>(
      'SELECT * FROM keysets WHERE unit = $1 AND active = true ORDER BY created_at DESC',
      [unit]
    )
    return result.rows.map(keysetFromRow)
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await query('UPDATE keysets SET active = $1 WHERE id = $2', [active, id])
  }

  async delete(id: string): Promise<void> {
    await query('DELETE FROM keysets WHERE id = $1', [id])
  }
}
