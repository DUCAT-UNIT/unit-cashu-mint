import { createHash } from 'crypto'
import { DepositStatus, IPaymentBackend, WithdrawalResult } from '../core/payment/types.js'
import { logger } from '../utils/logger.js'
import { createBolt11Invoice } from './bolt11.js'

const MAINNET = {
  bech32: 'bc',
  pubKeyHash: 0,
  scriptHash: 5,
  validWitnessVersions: [0, 1],
}
const FAKE_LIGHTNING_PRIVATE_KEY = '11'.repeat(32)

/**
 * Test-only bolt11 backend used by interop CI. It lets external wallets run the
 * real NUT-04/NUT-05 HTTP flows without LNbits or a live Lightning node.
 */
export class FakeLightningBackend implements IPaymentBackend {
  readonly method = 'bolt11'
  readonly unit = 'sat'
  private readonly feeReserve = 2
  private readonly feePaid = 1

  async createDepositAddress(quoteId: string, amount: bigint): Promise<string> {
    const invoice = await this.fakeInvoice(quoteId, amount)
    logger.info({ quoteId, amount: amount.toString() }, 'Created fake bolt11 mint quote')
    return invoice
  }

  async checkDeposit(
    quoteId: string,
    _request: string,
    _includeTracked: boolean = false,
    expectedAmount?: bigint
  ): Promise<DepositStatus> {
    return {
      confirmed: true,
      confirmations: 1,
      amount: expectedAmount,
      txid: this.paymentId(quoteId),
    }
  }

  async verifySpecificDeposit(
    quoteId: string,
    txid: string,
    _vout: number
  ): Promise<DepositStatus> {
    return {
      confirmed: true,
      confirmations: 1,
      amount: undefined,
      txid: txid || this.paymentId(quoteId),
    }
  }

  async estimateFee(_destination: string, _amount: bigint): Promise<number> {
    return this.feeReserve
  }

  async withdraw(_destination: string, _amount: bigint): Promise<WithdrawalResult> {
    return {
      txid: '0'.repeat(64),
      fee_paid: this.feePaid,
    }
  }

  async getBalance(): Promise<bigint> {
    return 21_000_000n
  }

  private paymentId(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private async fakeInvoice(quoteId: string, amount: bigint): Promise<string> {
    return createBolt11Invoice({
      network: MAINNET,
      satoshis: amount,
      timestamp: Math.floor(Date.now() / 1000),
      paymentHash: this.paymentId(`payment:${quoteId}`),
      description: `Ducat fake mint quote ${quoteId}`,
      expirySeconds: 3600,
      paymentSecret: this.paymentId(`secret:${quoteId}`),
      minFinalCltvExpiry: 9,
      privateKey: FAKE_LIGHTNING_PRIVATE_KEY,
    })
  }
}
