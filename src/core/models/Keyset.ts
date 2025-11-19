export interface Keyset {
  id: string // Keyset ID (14 chars hex)
  unit: string // "sat" or "RUNE"
  rune_id: string // "840000:3" (DUCAT•UNIT•RUNE)
  active: boolean
  private_keys: Record<number, string> // amount -> hex privkey (encrypted)
  public_keys: Record<number, string> // amount -> hex pubkey
  input_fee_ppk?: number // Input fee (parts per thousand)
  final_expiry?: number // Unix timestamp
  created_at: number
}

export interface KeysetRow {
  id: string
  unit: string
  rune_id: string
  active: boolean
  private_keys: Record<number, string> | string // JSONB (object or string)
  public_keys: Record<number, string> | string // JSONB (object or string)
  input_fee_ppk: number | null
  final_expiry: bigint | null
  created_at: bigint
}

export function keysetFromRow(row: KeysetRow): Keyset {
  return {
    id: row.id,
    unit: row.unit,
    rune_id: row.rune_id,
    active: row.active,
    private_keys:
      typeof row.private_keys === 'string' ? JSON.parse(row.private_keys) : row.private_keys,
    public_keys: typeof row.public_keys === 'string' ? JSON.parse(row.public_keys) : row.public_keys,
    input_fee_ppk: row.input_fee_ppk ?? undefined,
    final_expiry: row.final_expiry ? Number(row.final_expiry) : undefined,
    created_at: Number(row.created_at),
  }
}
