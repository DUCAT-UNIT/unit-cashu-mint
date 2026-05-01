import { createHash, randomBytes } from 'crypto'
import { DepositStatus, IPaymentBackend, WithdrawalResult } from '../core/payment/types.js'
import { logger } from '../utils/logger.js'

const VALID_REGTEST_INVOICES: Record<string, string> = {
  '62':
    'lnbcrt620n1pn0r3vepp5zljn7g09fsyeahl4rnhuy0xax2puhua5r3gspt7ttlfrley6valqdqqcqzzsxqyz5vqsp577h763sel3q06tfnfe75kvwn5pxn344sd5vnays65f9wfgx4fpzq9qxpqysgqg3re9afz9rwwalytec04pdhf9mvh3e2k4r877tw7dr4g0fvzf9sny5nlfggdy6nduy2dytn06w50ls34qfldgsj37x0ymxam0a687mspp0ytr8',
  '64':
    'lnbcrt640n1pn0r3tfpp5e30xac756gvd26cn3tgsh8ug6ct555zrvl7vsnma5cwp4g7auq5qdqqcqzzsxqyz5vqsp5xfhtzg0y3mekv6nsdnj43c346smh036t4f8gcfa2zwpxzwcryqvs9qxpqysgqw5juev8y3zxpdu0mvdrced5c6a852f9x7uh57g6fgjgcg5muqzd5474d7xgh770frazel67eejfwelnyr507q46hxqehala880rhlqspw07ta0',
}

/**
 * Test-only bolt11 backend used by interop CI. It lets external wallets run the
 * real NUT-04/NUT-05 HTTP flows without LNbits or a live Lightning node.
 */
export class FakeLightningBackend implements IPaymentBackend {
  readonly method = 'bolt11'
  readonly unit = 'sat'
  private readonly feeReserve = 2

  async createDepositAddress(quoteId: string, amount: bigint): Promise<string> {
    const invoice = VALID_REGTEST_INVOICES[amount.toString()] ?? this.fakeInvoice(quoteId, amount)
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
    const hrpAmount = amount > 0n ? `${amount * 10n}n` : ''
    return `lnbcrt${hrpAmount}1p${quoteId.slice(0, 12)}${randomBytes(16).toString('hex')}`
  }
}
