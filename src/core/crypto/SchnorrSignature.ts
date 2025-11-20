import { schnorr } from '@noble/curves/secp256k1'
import { createHash } from 'crypto'
import { logger } from '../../utils/logger.js'

/**
 * Schnorr signature utilities for P2PK (NUT-11)
 * Uses libsecp256k1 compatible 64-byte Schnorr signatures
 */

function sha256(data: string | Uint8Array): Uint8Array {
  const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
  return new Uint8Array(createHash('sha256').update(input).digest())
}

/**
 * Verify a Schnorr signature
 * @param message - The message that was signed (usually serialized Proof.secret)
 * @param signature - 64-byte Schnorr signature in hex
 * @param publicKey - 33-byte compressed public key in hex
 * @returns true if signature is valid
 */
export function verifySchnorrSignature(
  message: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    // Hash the message
    const messageHash = sha256(message)

    // Convert signature from hex (should be 128 hex chars = 64 bytes)
    if (signature.length !== 128) {
      logger.warn('Invalid Schnorr signature length', {
        expected: 128,
        actual: signature.length
      })
      return false
    }

    const sigBytes = Buffer.from(signature, 'hex')

    // Public key should be 33 bytes compressed (66 hex chars)
    // or 32 bytes x-only (64 hex chars) for Schnorr
    let pubkeyBytes: Uint8Array

    if (publicKey.length === 66) {
      // Compressed format (02/03 prefix) - convert to x-only
      pubkeyBytes = Buffer.from(publicKey.slice(2), 'hex')
    } else if (publicKey.length === 64) {
      // Already x-only format
      pubkeyBytes = Buffer.from(publicKey, 'hex')
    } else {
      logger.warn('Invalid public key length', {
        expected: '64 or 66',
        actual: publicKey.length
      })
      return false
    }

    // Verify using @noble/curves
    const isValid = schnorr.verify(sigBytes, messageHash, pubkeyBytes)

    return isValid
  } catch (err) {
    logger.error({ err, message: message.substring(0, 100) }, 'Schnorr verification failed')
    return false
  }
}

/**
 * Verify multiple signatures (for multisig P2PK)
 * @param message - The message to verify
 * @param signatures - Array of signature hex strings
 * @param publicKeys - Array of public key hex strings
 * @param requiredSigs - Minimum number of valid signatures required
 * @returns true if at least requiredSigs are valid
 */
export function verifyMultipleSignatures(
  message: string,
  signatures: string[],
  publicKeys: string[],
  requiredSigs: number = 1
): boolean {
  let validCount = 0

  for (const sig of signatures) {
    // Try each signature against all public keys
    for (const pubkey of publicKeys) {
      if (verifySchnorrSignature(message, sig, pubkey)) {
        validCount++
        break // This signature is valid, move to next
      }
    }
  }

  return validCount >= requiredSigs
}
