import { ProofState } from '../../types/cashu.js'

export interface ProofRecord {
  Y: string // hash_to_curve(secret) - primary key
  keyset_id: string
  amount: number
  secret: string // Original secret
  C: string // Signature point
  witness?: string // P2PK witness, HTLC witness
  state: ProofState // UNSPENT | PENDING | SPENT
  spent_at?: number
  transaction_id?: string // Quote ID or swap ID
}

export interface ProofRow {
  Y: string
  keyset_id: string
  amount: bigint
  secret: string
  C: string
  witness: string | null
  state: ProofState
  spent_at: bigint | null
  transaction_id: string | null
}

export function proofFromRow(row: ProofRow): ProofRecord {
  return {
    Y: row.Y,
    keyset_id: row.keyset_id,
    amount: Number(row.amount),
    secret: row.secret,
    C: row.C,
    witness: row.witness ?? undefined,
    state: row.state,
    spent_at: row.spent_at ? Number(row.spent_at) : undefined,
    transaction_id: row.transaction_id ?? undefined,
  }
}
