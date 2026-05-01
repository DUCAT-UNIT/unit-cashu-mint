export type {
  Token,
  MintKeys,
  MintKeyset,
} from '@cashu/cashu-ts'

// Define BlindedMessage interface (compatible with cashu-ts)
export interface BlindedMessage {
  amount: number
  B_: string // Blinded message point (hex)
  id: string // Keyset ID
}

export interface BlindSignature {
  id: string
  amount: number
  C_: string
  dleq?: SerializedDLEQ
}

export interface Proof {
  id: string
  amount: number
  secret: string
  C: string
  dleq?: SerializedDLEQ
  p2pk_e?: string
  witness?: string | Record<string, unknown>
}

// Define types that may not be exported
export interface SerializedDLEQ {
  s: string
  e: string
  r?: string
}

/**
 * Custom types for our Runes mint
 */

export type MintQuoteState = 'UNPAID' | 'PAID' | 'ISSUED'
export type MeltQuoteState = 'UNPAID' | 'PENDING' | 'PAID'
export type ProofState = 'UNSPENT' | 'PENDING' | 'SPENT'

export interface MintQuoteResponse {
  quote: string
  request: string // Runes deposit address
  state: MintQuoteState
  expiry: number
  amount: number
  unit: string
  pubkey?: string
}

export interface OnchainMintQuoteResponse {
  quote: string
  request: string // Bitcoin deposit address
  unit: string
  expiry: number | null
  pubkey: string
  amount_paid: number
  amount_issued: number
}

export interface MeltQuoteResponse {
  quote: string
  amount: number
  fee_reserve: number
  state: MeltQuoteState
  expiry: number
  request: string // Runes destination address
  unit: string
  txid?: string
  payment_preimage?: string | null
}

export interface OnchainMeltQuoteResponse {
  quote: string
  request: string // Bitcoin destination address
  amount: number
  unit: string
  fee: number
  estimated_blocks: number
  state: MeltQuoteState
  expiry: number
  outpoint?: string
}

export interface MintInfoResponse {
  name: string
  pubkey: string
  version: string
  description: string
  description_long?: string
  contact?: Array<{ method: string; info: string }>
  motd?: string
  nuts: Record<string, unknown>
}
