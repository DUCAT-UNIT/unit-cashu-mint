import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import {
  OrdAddressResponse,
  OrdOutputResponse,
  EsploraUtxo,
  EsploraTransaction,
  EsploraOutspendResponse,
} from './types.js'

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000, // ms
  maxDelay: 10000, // ms
  backoffMultiplier: 2,
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch with retry logic and exponential backoff
 */
async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  description: string = 'API request'
): Promise<T> {
  let lastError: Error | null = null
  let delay = RETRY_CONFIG.initialDelay

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      return data as T
    } catch (error) {
      lastError = error as Error

      if (attempt < RETRY_CONFIG.maxRetries) {
        logger.warn(
          { attempt, delay, error: lastError.message, url, description },
          `Retrying ${description}`
        )
        await sleep(delay)
        delay = Math.min(delay * RETRY_CONFIG.backoffMultiplier, RETRY_CONFIG.maxDelay)
      }
    }
  }

  logger.error({ error: lastError, url, description }, `Failed ${description} after all retries`)
  throw lastError
}

/**
 * Ord Indexer API Client
 */
export class OrdClient {
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || env.ORD_URL
  }

  /**
   * Get all outputs for an address with runes balances
   */
  async getAddressOutputs(address: string): Promise<OrdAddressResponse> {
    const url = `${this.baseUrl}/address/${address}`
    return fetchWithRetry<OrdAddressResponse>(
      url,
      {
        headers: {
          'Accept': 'application/json',
        },
      },
      `Ord address lookup: ${address}`
    )
  }

  /**
   * Get details for a specific UTXO including runes data
   */
  async getOutput(txid: string, vout: number): Promise<OrdOutputResponse> {
    const url = `${this.baseUrl}/output/${txid}:${vout}`
    return fetchWithRetry<OrdOutputResponse>(
      url,
      {
        headers: {
          'Accept': 'application/json',
        },
      },
      `Ord output lookup: ${txid}:${vout}`
    )
  }
}

/**
 * Esplora API Client
 */
export class EsploraClient {
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || env.ESPLORA_URL
  }

  /**
   * Get all UTXOs for an address
   */
  async getAddressUtxos(address: string): Promise<EsploraUtxo[]> {
    const url = `${this.baseUrl}/address/${address}/utxo`
    return fetchWithRetry<EsploraUtxo[]>(url, {}, `Esplora UTXO lookup: ${address}`)
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string): Promise<EsploraTransaction> {
    const url = `${this.baseUrl}/tx/${txid}`
    return fetchWithRetry<EsploraTransaction>(url, {}, `Esplora tx lookup: ${txid}`)
  }

  /**
   * Get raw transaction hex
   */
  async getTransactionHex(txid: string): Promise<string> {
    const url = `${this.baseUrl}/tx/${txid}/hex`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch tx hex: ${response.status} ${response.statusText}`)
    }

    return response.text()
  }

  /**
   * Check if a specific output has been spent
   */
  async getOutspend(txid: string, vout: number): Promise<EsploraOutspendResponse> {
    const url = `${this.baseUrl}/tx/${txid}/outspend/${vout}`
    return fetchWithRetry<EsploraOutspendResponse>(
      url,
      {},
      `Esplora outspend check: ${txid}:${vout}`
    )
  }

  /**
   * Broadcast a transaction
   */
  async broadcastTransaction(txHex: string): Promise<string> {
    const url = `${this.baseUrl}/tx`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: txHex,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to broadcast tx: ${response.status} ${errorText}`)
    }

    const txid = await response.text()
    return txid
  }

  /**
   * Get current block height
   */
  async getBlockHeight(): Promise<number> {
    const url = `${this.baseUrl}/blocks/tip/height`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch block height: ${response.status}`)
    }

    const height = await response.text()
    return parseInt(height, 10)
  }

  /**
   * Get fee estimates
   */
  async getFeeEstimates(): Promise<Record<string, number>> {
    const url = `${this.baseUrl}/fee-estimates`
    return fetchWithRetry<Record<string, number>>(url, {}, 'Esplora fee estimates')
  }
}

/**
 * Convenience function to create singleton clients
 */
let ordClientInstance: OrdClient | null = null
let esploraClientInstance: EsploraClient | null = null

export function getOrdClient(): OrdClient {
  if (!ordClientInstance) {
    ordClientInstance = new OrdClient()
  }
  return ordClientInstance
}

export function getEsploraClient(): EsploraClient {
  if (!esploraClientInstance) {
    esploraClientInstance = new EsploraClient()
  }
  return esploraClientInstance
}
