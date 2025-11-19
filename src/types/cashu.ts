/**
 * Re-export cashu-ts types for convenience
 */
export type {
  Proof as CashuProof,
  SerializedBlindedSignature as BlindSignature,
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

// Extend Proof type with witness field
import type { Proof as CashuProofBase } from '@cashu/cashu-ts'
export interface Proof extends CashuProofBase {
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
