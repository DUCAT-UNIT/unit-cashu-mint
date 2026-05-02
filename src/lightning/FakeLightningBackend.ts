import { createHash } from 'crypto'
import { encode, sign, type TagData } from 'bolt11'
import { DepositStatus, IPaymentBackend, WithdrawalResult } from '../core/payment/types.js'
import { logger } from '../utils/logger.js'

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

  async createDepositAddress(quoteId: string, amount: bigint): Promise<string> {
    const invoice = this.fakeInvoice(quoteId, amount)
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
      fee_paid: 0,
    }
  }

  async getBalance(): Promise<bigint> {
    return 21_000_000n
  }

  private paymentId(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private fakeInvoice(quoteId: string, amount: bigint): string {
    const encoded = encode(
      {
        network: MAINNET,
        satoshis: Number(amount),
        timestamp: Math.floor(Date.now() / 1000),
        tags: [
          { tagName: 'payment_hash', data: this.paymentId(`payment:${quoteId}`) },
          { tagName: 'description', data: `Ducat fake mint quote ${quoteId}` },
          { tagName: 'expire_time', data: 3600 },
          { tagName: 'payment_secret', data: this.paymentId(`secret:${quoteId}`) },
          {
            tagName: 'feature_bits',
            data: {
              word_length: 4,
              payment_secret: {
                required: false,
                supported: true,
              },
            } as unknown as TagData,
          },
          { tagName: 'min_final_cltv_expiry', data: 9 },
        ],
      },
      true
    )
    const signed = sign(encoded, FAKE_LIGHTNING_PRIVATE_KEY)
    if (!signed.paymentRequest) {
      throw new Error('Failed to build fake bolt11 invoice')
    }
    return signed.paymentRequest
  }
}
