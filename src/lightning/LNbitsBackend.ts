import { IPaymentBackend, DepositStatus, WithdrawalResult } from '../core/payment/types.js'
import { logger } from '../utils/logger.js'

interface LNbitsConfig {
  baseUrl: string
  invoiceKey: string
  adminKey: string
  feeReserve: number
}

interface LNbitsCreateInvoiceResponse {
  payment_hash?: string
  checking_id?: string
  payment_request?: string
  bolt11?: string
}

interface LNbitsPaymentResponse {
  paid?: boolean
  payment_hash?: string
  checking_id?: string
  payment_request?: string
  bolt11?: string
  amount?: number
  fee?: number
  preimage?: string
  payment_preimage?: string
}

export class LNbitsBackend implements IPaymentBackend {
  readonly method = 'bolt11'
  readonly unit = 'sat'

  constructor(private config: LNbitsConfig) {}

  async createDepositAddress(quoteId: string, amount: bigint): Promise<string> {
    const response = await this.request<LNbitsCreateInvoiceResponse>(
      '/api/v1/payments',
      {
        method: 'POST',
        key: this.config.invoiceKey,
        body: {
          out: false,
          amount: Number(amount),
          memo: `Ducat mint quote ${quoteId}`,
          unit: 'sat',
        },
      }
    )

    const invoice = response.payment_request ?? response.bolt11
    if (!invoice) {
      throw new Error('LNbits did not return a bolt11 invoice')
    }

    logger.info({ quoteId, paymentHash: response.payment_hash ?? response.checking_id }, 'Created bolt11 mint quote')
    return invoice
  }

  async checkDeposit(
    quoteId: string,
    request: string,
    _includeTracked: boolean = false,
    expectedAmount?: bigint
  ): Promise<DepositStatus> {
    const payment = await this.findPaymentByInvoice(request)

    if (!payment?.paid) {
      return { confirmed: false, confirmations: 0 }
    }

    return {
      confirmed: true,
      confirmations: 1,
      amount: expectedAmount ?? this.amountFromPayment(payment),
      txid: payment.payment_hash ?? payment.checking_id ?? quoteId,
    }
  }

  async verifySpecificDeposit(
    quoteId: string,
    txid: string,
    _vout: number
  ): Promise<DepositStatus> {
    const payment = await this.getPayment(txid)

    return {
      confirmed: payment.paid === true,
      confirmations: payment.paid ? 1 : 0,
      amount: this.amountFromPayment(payment),
      txid: payment.payment_hash ?? payment.checking_id ?? quoteId,
    }
  }

  async estimateFee(_destination: string, _amount: bigint): Promise<number> {
    return this.config.feeReserve
  }

  async withdraw(destination: string, _amount: bigint): Promise<WithdrawalResult> {
    const response = await this.request<LNbitsPaymentResponse>(
      '/api/v1/payments',
      {
        method: 'POST',
        key: this.config.adminKey,
        body: {
          out: true,
          bolt11: destination,
        },
      }
    )

    const paymentHash = response.payment_hash ?? response.checking_id
    if (!paymentHash) {
      throw new Error('LNbits did not return a payment hash')
    }

    return {
      txid: paymentHash,
      fee_paid: Math.abs(response.fee ?? 0),
    }
  }

  async getBalance(): Promise<bigint> {
    return 0n
  }

  private async findPaymentByInvoice(invoice: string): Promise<LNbitsPaymentResponse | null> {
    const payments = await this.request<LNbitsPaymentResponse[]>(
      '/api/v1/payments?limit=100&offset=0',
      {
        method: 'GET',
        key: this.config.invoiceKey,
      }
    )

    return payments.find((payment) => {
      return payment.payment_request === invoice || payment.bolt11 === invoice
    }) ?? null
  }

  private async getPayment(checkingId: string): Promise<LNbitsPaymentResponse> {
    return this.request<LNbitsPaymentResponse>(
      `/api/v1/payments/${checkingId}`,
      {
        method: 'GET',
        key: this.config.invoiceKey,
      }
    )
  }

  private amountFromPayment(payment: LNbitsPaymentResponse): bigint | undefined {
    if (typeof payment.amount !== 'number') {
      return undefined
    }

    return BigInt(Math.floor(Math.abs(payment.amount) / 1000))
  }

  private async request<T>(
    path: string,
    options: { method: string; key: string; body?: Record<string, unknown> }
  ): Promise<T> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': options.key,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LNbits request failed: ${response.status} ${errorText}`)
    }

    return response.json() as Promise<T>
  }
}
