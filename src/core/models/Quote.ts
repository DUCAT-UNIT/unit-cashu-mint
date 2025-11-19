import { MintQuoteState, MeltQuoteState } from '../../types/cashu.js'

export interface MintQuote {
  id: string // Quote ID
  amount: number // Amount to mint
  unit: string // Unit type
  rune_id: string // Rune identifier
  request: string // Deposit address
  state: MintQuoteState // UNPAID | PAID | ISSUED
  expiry: number // Unix timestamp
  created_at: number
  paid_at?: number
  txid?: string // Runes deposit txid
  vout?: number // Runes deposit vout
}

export interface MintQuoteRow {
  id: string
  amount: bigint
  unit: string
  rune_id: string
  request: string
  state: MintQuoteState
  expiry: bigint
  created_at: bigint
  paid_at: bigint | null
  txid: string | null
  vout: number | null
}

export function mintQuoteFromRow(row: MintQuoteRow): MintQuote {
  return {
    id: row.id,
    amount: Number(row.amount),
    unit: row.unit,
    rune_id: row.rune_id,
    request: row.request,
    state: row.state,
    expiry: Number(row.expiry),
    created_at: Number(row.created_at),
    paid_at: row.paid_at ? Number(row.paid_at) : undefined,
    txid: row.txid ?? undefined,
    vout: row.vout ?? undefined,
  }
}

export interface MeltQuote {
  id: string
  amount: number
  fee_reserve: number // Reserved for miner fees
  unit: string
  rune_id: string
  request: string // Destination address
  state: MeltQuoteState // UNPAID | PENDING | PAID
  expiry: number
  created_at: number
  paid_at?: number
  txid?: string // Runes withdrawal txid
  fee_paid?: number // Actual fee paid
}

export interface MeltQuoteRow {
  id: string
  amount: bigint
  fee_reserve: bigint
  unit: string
  rune_id: string
  request: string
  state: MeltQuoteState
  expiry: bigint
  created_at: bigint
  paid_at: bigint | null
  txid: string | null
  fee_paid: bigint | null
}

export function meltQuoteFromRow(row: MeltQuoteRow): MeltQuote {
  return {
    id: row.id,
    amount: Number(row.amount),
    fee_reserve: Number(row.fee_reserve),
    unit: row.unit,
    rune_id: row.rune_id,
    request: row.request,
    state: row.state,
    expiry: Number(row.expiry),
    created_at: Number(row.created_at),
    paid_at: row.paid_at ? Number(row.paid_at) : undefined,
    txid: row.txid ?? undefined,
    fee_paid: row.fee_paid ? Number(row.fee_paid) : undefined,
  }
}
