import { describe, it, expect } from 'vitest'
import {
  MintError,
  ProofAlreadySpentError,
  InvalidProofError,
  QuoteNotFoundError,
  QuoteNotPaidError,
  QuoteExpiredError,
  QuoteAlreadyIssuedError,
  InsufficientAmountError,
  AmountMismatchError,
  KeysetNotFoundError,
  KeysetInactiveError,
  RunesDepositNotFoundError,
  RunesWithdrawalFailedError,
  InsufficientReservesError,
} from '../../../src/utils/errors.js'

describe('Error Classes', () => {
  it('MintError should serialize to JSON', () => {
    const error = new MintError('Test error', 12345, 'test detail')

    expect(error.message).toBe('Test error')
    expect(error.code).toBe(12345)
    expect(error.detail).toBe('test detail')

    const json = error.toJSON()
    expect(json.error).toBe('Test error')
    expect(json.code).toBe(12345)
    expect(json.detail).toBe('test detail')
  })

  it('ProofAlreadySpentError should have correct code and detail', () => {
    const error = new ProofAlreadySpentError('02abc123')

    expect(error.message).toBe('Proof already spent')
    expect(error.code).toBe(11001)
    expect(error.detail).toBe('Y=02abc123')
  })

  it('InvalidProofError should have correct code and detail', () => {
    const error = new InvalidProofError('invalid signature')

    expect(error.message).toBe('Invalid proof')
    expect(error.code).toBe(11002)
    expect(error.detail).toBe('invalid signature')
  })

  it('QuoteNotFoundError should have correct message and detail', () => {
    const error = new QuoteNotFoundError('quote123')

    expect(error.message).toBe('Quote not found')
    expect(error.detail).toBe('quote=quote123')
    expect(error.code).toBe(10000)
  })

  it('QuoteNotPaidError should have correct message and detail', () => {
    const error = new QuoteNotPaidError('quote456')

    expect(error.message).toBe('Quote not paid')
    expect(error.detail).toBe('quote=quote456')
    expect(error.code).toBe(10001)
  })

  it('QuoteExpiredError should have correct message and detail', () => {
    const error = new QuoteExpiredError('quote789')

    expect(error.message).toBe('Quote expired')
    expect(error.detail).toBe('quote=quote789')
    expect(error.code).toBe(10002)
  })

  it('QuoteAlreadyIssuedError should have correct message and detail', () => {
    const error = new QuoteAlreadyIssuedError('quote999')

    expect(error.message).toBe('Quote already issued')
    expect(error.detail).toBe('quote=quote999')
    expect(error.code).toBe(10003)
  })

  it('InsufficientAmountError should have correct message and detail', () => {
    const error = new InsufficientAmountError(100, 50)

    expect(error.message).toBe('Insufficient amount')
    expect(error.detail).toBe('required=100, provided=50')
    expect(error.code).toBe(12000)
  })

  it('AmountMismatchError should have correct message and detail', () => {
    const error = new AmountMismatchError(100, 90)

    expect(error.message).toBe('Amount mismatch')
    expect(error.detail).toBe('expected=100, actual=90')
    expect(error.code).toBe(12001)
  })

  it('KeysetNotFoundError should have correct message and detail', () => {
    const error = new KeysetNotFoundError('keyset123')

    expect(error.message).toBe('Keyset not found')
    expect(error.detail).toBe('id=keyset123')
    expect(error.code).toBe(13000)
  })

  it('KeysetInactiveError should have correct message and detail', () => {
    const error = new KeysetInactiveError('keyset456')

    expect(error.message).toBe('Keyset inactive')
    expect(error.detail).toBe('id=keyset456')
    expect(error.code).toBe(13001)
  })

  it('RunesDepositNotFoundError should have correct message and detail', () => {
    const error = new RunesDepositNotFoundError('txid123')

    expect(error.message).toBe('Runes deposit not found')
    expect(error.detail).toBe('txid=txid123')
    expect(error.code).toBe(14000)
  })

  it('RunesWithdrawalFailedError should have correct message and detail', () => {
    const error = new RunesWithdrawalFailedError('insufficient balance')

    expect(error.message).toBe('Runes withdrawal failed')
    expect(error.detail).toBe('insufficient balance')
    expect(error.code).toBe(14001)
  })

  it('InsufficientReservesError should have correct message and detail', () => {
    const error = new InsufficientReservesError('840000:3', 1000, 500)

    expect(error.message).toBe('Insufficient reserves')
    expect(error.detail).toBe('rune=840000:3, required=1000, available=500')
    expect(error.code).toBe(14002)
  })

  it('All errors should be instances of Error and MintError', () => {
    const errors = [
      new MintError('test', 1),
      new ProofAlreadySpentError('Y'),
      new InvalidProofError('test'),
      new QuoteNotFoundError('id'),
      new QuoteNotPaidError('id'),
      new QuoteExpiredError('id'),
      new QuoteAlreadyIssuedError('id'),
      new InsufficientAmountError(100, 50),
      new AmountMismatchError(100, 90),
      new KeysetNotFoundError('id'),
      new KeysetInactiveError('id'),
      new RunesDepositNotFoundError('txid'),
      new RunesWithdrawalFailedError('detail'),
      new InsufficientReservesError('rune', 100, 50),
    ]

    errors.forEach(error => {
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(MintError)
    })
  })

  it('All errors should serialize to JSON correctly', () => {
    const error = new QuoteNotFoundError('test123')
    const json = error.toJSON()

    expect(json).toHaveProperty('error')
    expect(json).toHaveProperty('code')
    expect(json).toHaveProperty('detail')
    expect(json.error).toBe('Quote not found')
    expect(json.code).toBe(10000)
    expect(json.detail).toBe('quote=test123')
  })
})
