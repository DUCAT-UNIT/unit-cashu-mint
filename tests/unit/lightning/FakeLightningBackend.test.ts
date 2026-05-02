import { describe, expect, it } from 'vitest'
import { decode } from 'bolt11'
import { FakeLightningBackend } from '../../../src/lightning/FakeLightningBackend.js'

describe('FakeLightningBackend', () => {
  it('creates deterministic paid bolt11 quotes for interop tests', async () => {
    const backend = new FakeLightningBackend()

    const invoice = await backend.createDepositAddress('quote-id', 62n)
    const status = await backend.checkDeposit('quote-id', invoice, false, 62n)
    const decoded = decode(invoice)

    expect(invoice).toContain('lnbc620n')
    expect(decoded.satoshis).toBe(62)
    expect(decoded.network.bech32).toBe('bc')
    expect(status).toEqual({
      confirmed: true,
      confirmations: 1,
      amount: 62n,
      txid: expect.any(String),
    })
  })

  it('uses a fee reserve and reports paid fee for fake withdrawals', async () => {
    const backend = new FakeLightningBackend()

    await expect(backend.estimateFee('lnbc...', 62n)).resolves.toBe(2)
    await expect(backend.withdraw('lnbc...', 62n)).resolves.toEqual({
      txid: '0'.repeat(64),
      fee_paid: 1,
    })
  })
})
