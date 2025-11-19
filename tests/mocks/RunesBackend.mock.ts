import { IPaymentBackend, RunesDepositStatus, RunesWithdrawalResult } from '../../src/runes/RunesBackend.js'

/**
 * Mock RunesBackend for testing
 * Simulates Runes operations without requiring actual blockchain interaction
 */
export class MockRunesBackend implements IPaymentBackend {
  private deposits = new Map<string, { confirmed: boolean; amount: bigint }>()
  private balances = new Map<string, bigint>()

  /**
   * Create a mock deposit address
   */
  async createDepositAddress(quoteId: string, amount: bigint, runeId: string): Promise<string> {
    // Generate a fake taproot address
    const mockAddress = `bc1p${quoteId.slice(0, 58)}`

    // Initialize deposit as unconfirmed
    this.deposits.set(mockAddress, { confirmed: false, amount })

    return mockAddress
  }

  /**
   * Check deposit status
   * By default returns unconfirmed, tests can call simulateDeposit() to mark as confirmed
   */
  async checkDeposit(_quoteId: string, depositAddress: string): Promise<RunesDepositStatus> {
    const deposit = this.deposits.get(depositAddress)

    if (!deposit) {
      return {
        confirmed: false,
        confirmations: 0,
      }
    }

    if (deposit.confirmed) {
      return {
        confirmed: true,
        amount: deposit.amount,
        txid: 'mock_txid_' + depositAddress.slice(-8),
        vout: 0,
        confirmations: 1,
      }
    }

    return {
      confirmed: false,
      confirmations: 0,
    }
  }

  /**
   * Estimate fee for withdrawal
   */
  async estimateFee(_destination: string, _amount: bigint, _runeId: string): Promise<number> {
    return 1000 // Fixed fee for tests
  }

  /**
   * Send Runes (withdrawal)
   * For tests, this just succeeds immediately
   */
  async sendRunes(
    _destination: string,
    amount: bigint,
    runeId: string
  ): Promise<RunesWithdrawalResult> {
    // Deduct from balance
    const currentBalance = this.balances.get(runeId) || 0n
    if (currentBalance < amount) {
      throw new Error('Insufficient balance')
    }

    this.balances.set(runeId, currentBalance - amount)

    // Return mock transaction
    return {
      txid: 'mock_withdrawal_txid_' + Math.random().toString(36).slice(2),
      fee_paid: 1000,
    }
  }

  /**
   * Get balance for a rune
   */
  async getBalance(runeId: string): Promise<bigint> {
    return this.balances.get(runeId) || 0n
  }

  /**
   * Sync UTXOs from blockchain (mock - does nothing)
   */
  async syncUtxos(): Promise<void> {
    // Mock implementation - in real backend this syncs from blockchain
    return Promise.resolve()
  }

  /**
   * Test helper: Simulate a confirmed deposit
   */
  simulateDeposit(quoteId: string, depositAddress: string, amount: bigint): void {
    this.deposits.set(depositAddress, { confirmed: true, amount })
  }

  /**
   * Test helper: Set balance for a rune
   */
  setBalance(runeId: string, amount: bigint): void {
    this.balances.set(runeId, amount)
  }

  /**
   * Test helper: Reset all state
   */
  reset(): void {
    this.deposits.clear()
    this.balances.clear()
  }
}
