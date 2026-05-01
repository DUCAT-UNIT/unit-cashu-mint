import { describe, expect, it } from 'vitest'
import { FakeLightningBackend } from '../../../src/lightning/FakeLightningBackend.js'

describe('FakeLightningBackend', () => {
  it('creates deterministic paid bolt11 quotes for interop tests', async () => {
    const backend = new FakeLightningBackend()

    const invoice = await backend.createDepositAddress('quote-id', 62n)
    const status = await backend.checkDeposit('quote-id', invoice, false, 62n)

    expect(invoice).toMatch(/^lnbcrt620n/)
    expect(status).toEqual({
      confirmed: true,
      confirmations: 1,
      amount: 62n,
      txid: expect.any(String),
    })
  })

  it('uses a fee reserve but settles fake withdrawals with zero paid fee', async () => {
    const backend = new FakeLightningBackend()

    await expect(backend.estimateFee('lnbcrt...', 62n)).resolves.toBe(2)
    await expect(backend.withdraw('lnbcrt...', 62n)).resolves.toEqual({
      txid: '0'.repeat(64),
      fee_paid: 0,
    })
  })
})
