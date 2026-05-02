import { describe, expect, it } from 'vitest'
import { buildMintInfo } from '../../src/mint-info.js'

const baseConfig = {
  SUPPORTED_UNITS_ARRAY: ['unit', 'sat'],
  SUPPORTS_BITCOIN: true,
  SUPPORTS_LIGHTNING: true,
  MIN_MINT_AMOUNT: 1,
  MAX_MINT_AMOUNT: 1000000,
  MIN_MELT_AMOUNT: 1,
  MAX_MELT_AMOUNT: 1000000,
  MINT_CONFIRMATIONS: 2,
  MINT_NAME: 'Test Mint',
  MINT_PUBKEY: '02' + '11'.repeat(32),
  MINT_DESCRIPTION: 'Test mint',
}

describe('buildMintInfo', () => {
  it('advertises UNIT with the same onchain method shape as BTC', () => {
    const info = buildMintInfo(baseConfig)
    const mintMethods = info.nuts['4'].methods
    const meltMethods = info.nuts['5'].methods

    expect(mintMethods).toContainEqual({
      method: 'onchain',
      unit: 'unit',
      min_amount: 1,
      max_amount: 1000000,
      options: { confirmations: 2 },
    })
    expect(mintMethods).toContainEqual({
      method: 'onchain',
      unit: 'sat',
      min_amount: 1,
      max_amount: 1000000,
      options: { confirmations: 2 },
    })
    expect(meltMethods).toContainEqual({
      method: 'onchain',
      unit: 'unit',
      min_amount: 1,
      max_amount: 1000000,
    })
    expect(meltMethods).toContainEqual({
      method: 'onchain',
      unit: 'sat',
      min_amount: 1,
      max_amount: 1000000,
    })
  })

  it('does not advertise the legacy unit payment method', () => {
    const info = buildMintInfo(baseConfig)

    expect(info.nuts['4'].methods).not.toContainEqual(
      expect.objectContaining({ method: 'unit', unit: 'unit' })
    )
    expect(info.nuts['5'].methods).not.toContainEqual(
      expect.objectContaining({ method: 'unit', unit: 'unit' })
    )
  })

  it('advertises bolt11 only when Lightning is enabled', () => {
    const info = buildMintInfo({ ...baseConfig, SUPPORTS_LIGHTNING: false })

    expect(info.nuts['8']).toEqual({ supported: false })
    expect(info.nuts['23']).toEqual({ supported: false })
    expect(info.nuts['4'].methods).not.toContainEqual(
      expect.objectContaining({ method: 'bolt11' })
    )
    expect(info.nuts['5'].methods).not.toContainEqual(
      expect.objectContaining({ method: 'bolt11' })
    )
  })

  it('advertises NUT-08 for Lightning and does not claim DLEQ support yet', () => {
    const info = buildMintInfo(baseConfig)

    expect(info.nuts['8']).toEqual({ supported: true })
    expect(info.nuts['12']).toEqual({ supported: false })
  })

  it('uses a NUT-06 implementation/version string for CDK parsers', () => {
    const info = buildMintInfo(baseConfig)

    expect(info.version).toBe('ducat-mint/0.1.0')
  })
})
