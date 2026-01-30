/**
 * Payment backend types - unit-agnostic interfaces for deposit/withdrawal operations
 */

/**
 * Status of a deposit check
 */
export interface DepositStatus {
  confirmed: boolean
  amount?: bigint
  txid?: string
  vout?: number
  confirmations: number
}

/**
 * Result of a withdrawal operation
 */
export interface WithdrawalResult {
  txid: string
  fee_paid: number
}

/**
 * Abstract payment backend interface
 * Implemented by BTCBackend and RunesBackend
 */
export interface IPaymentBackend {
  /** The unit this backend handles (e.g., 'btc', 'sat') */
  readonly unit: string

  /**
   * Create a deposit address for a mint quote
   * @param quoteId - The quote ID
   * @param amount - Amount in smallest units
   * @returns Deposit address
   */
  createDepositAddress(quoteId: string, amount: bigint): Promise<string>

  /**
   * Check if a deposit has been received
   * @param quoteId - The quote ID
   * @param address - The deposit address to check
   * @param includeTracked - If true, also check already-tracked UTXOs
   * @param expectedAmount - Expected amount for this quote (for exact UTXO matching)
   * @returns Deposit status
   */
  checkDeposit(
    quoteId: string,
    address: string,
    includeTracked?: boolean,
    expectedAmount?: bigint
  ): Promise<DepositStatus>

  /**
   * Verify a specific deposit by txid/vout
   * @param quoteId - The quote ID
   * @param txid - Transaction ID
   * @param vout - Output index
   * @returns Deposit status
   */
  verifySpecificDeposit(
    quoteId: string,
    txid: string,
    vout: number
  ): Promise<DepositStatus>

  /**
   * Estimate fee for a withdrawal
   * @param destination - Destination address
   * @param amount - Amount to withdraw
   * @returns Estimated fee in satoshis
   */
  estimateFee(destination: string, amount: bigint): Promise<number>

  /**
   * Execute a withdrawal
   * @param destination - Destination address
   * @param amount - Amount to withdraw
   * @returns Withdrawal result with txid and fee paid
   */
  withdraw(destination: string, amount: bigint): Promise<WithdrawalResult>

  /**
   * Get the current balance
   * @returns Balance in smallest units
   */
  getBalance(): Promise<bigint>

  /**
   * Sync UTXOs from blockchain (optional - only Runes needs this)
   */
  syncUtxos?(): Promise<void>
}
