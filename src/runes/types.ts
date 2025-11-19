/**
 * Runes-specific types for the mint server
 */

export interface RuneId {
  block: bigint
  tx: bigint
}

export interface RuneUtxo {
  txid: string
  vout: number
  value: number // sats
  address: string
  runeAmount: bigint // amount of runes in this UTXO
  runeName: string
  runeId: RuneId
  confirmations?: number
}

export interface SatUtxo {
  txid: string
  vout: number
  value: number // sats
  address: string
  confirmations?: number
}

export interface RuneEdict {
  id: RuneId
  amount: bigint
  output: number // output index that receives the runes
}

export interface RunestoneConfig {
  edicts: RuneEdict[]
  pointer?: number // default output for unallocated runes
}

export interface TransactionIntent {
  psbt: any // Will be typed as bitcoin.Psbt after import
  fee: number
  runeUtxo: RuneUtxo
  satUtxo: SatUtxo
}

export interface OrdAddressResponse {
  outputs: string[] // Array of "txid:vout"
  runes_balances?: Array<[string, string, string]> // [name, amount, symbol]
}

export interface OrdOutputResponse {
  transaction: string
  value: number
  runes?: Record<string, {
    amount: string
    id: string // "block:tx"
  }>
}

export interface EsploraUtxo {
  txid: string
  vout: number
  value: number
  status: {
    confirmed: boolean
    block_height?: number
    block_time?: number
  }
}

export interface EsploraTransaction {
  txid: string
  version: number
  locktime: number
  vin: Array<{
    txid: string
    vout: number
    prevout?: {
      scriptpubkey: string
      scriptpubkey_address?: string
      value: number
    }
    scriptsig?: string
    witness?: string[]
    is_coinbase: boolean
    sequence: number
  }>
  vout: Array<{
    scriptpubkey: string
    scriptpubkey_asm?: string
    scriptpubkey_type?: string
    scriptpubkey_address?: string
    value: number
  }>
  size: number
  weight: number
  fee?: number
  status: {
    confirmed: boolean
    block_height?: number
    block_hash?: string
    block_time?: number
  }
}

export interface EsploraOutspendResponse {
  spent: boolean
  txid?: string
  vin?: number
  status?: {
    confirmed: boolean
    block_height?: number
  }
}

export interface RunesDepositStatus {
  confirmed: boolean
  amount?: bigint
  txid?: string
  vout?: number
  confirmations: number
}

export interface RunesWithdrawalResult {
  txid: string
  fee_paid: number
}

// Constants for the DUCAT•UNIT•RUNE token
export const DUCAT_UNIT_RUNE: RuneId = {
  block: 1527352n,
  tx: 1n,
}

export const DUCAT_UNIT_RUNE_NAME = 'DUCAT•UNIT•RUNE'

// Transaction constants from the app
export const RUNES_TX_CONSTANTS = {
  FEE: 1000, // sats
  RECIPIENT_SATS: 10000, // sats sent with runes to recipient
  RUNE_RETURN_SATS: 10000, // sats for taproot return address
  DUST_LIMIT: 546, // minimum sats for an output
  MIN_SAT_UTXO: 12000, // minimum sats needed in fee UTXO
} as const
