/**
 * BTC Backend types
 */

export interface BTCConfig {
  /** P2WPKH address for BTC deposits */
  mintAddress: string
  /** Public key for signing (compressed, 33 bytes hex) */
  mintPubkey: string
  /** Fee rate in sats/vbyte */
  feeRate: number
  /** Bitcoin network (mainnet, testnet, etc.) */
  network: string
  /** Minimum confirmations required */
  minConfirmations: number
}

export interface BTCUtxo {
  txid: string
  vout: number
  value: number // sats
  address: string
  confirmations?: number
  accountIndex?: number
}
