import { describe, expect, it } from 'vitest'
import { deriveKeysetId, Keyset } from '@cashu/cashu-ts'
import { deriveMintKeysetId } from '../../../src/core/crypto/KeyManager.js'

describe('deriveMintKeysetId', () => {
  const publicKeys = {
    1: '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104',
    2: '03b0f36d6d47ce14df8a7be9137712c42bcdd960b19dd02f1d4a9703b1f31d7513',
    4: '0366be6e026e42852498efb82014ca91e89da2e7a5bd3761bdad699fa2aec9fe09',
  }

  it('derives a NUT-02 v2 keyset id that cashu-ts verifies', () => {
    const id = deriveMintKeysetId(publicKeys, 'sat')

    expect(id).toMatch(/^01[0-9a-f]{64}$/)
    expect(id).toBe(deriveKeysetId(publicKeys, { unit: 'sat', input_fee_ppk: 0 }))
    expect(
      Keyset.verifyKeysetId({
        id,
        unit: 'sat',
        active: true,
        input_fee_ppk: 0,
        keys: publicKeys,
      })
    ).toBe(true)
  })

  it('binds the keyset id to the unit', () => {
    expect(deriveMintKeysetId(publicKeys, 'unit')).not.toBe(deriveMintKeysetId(publicKeys, 'sat'))
  })
})
