import { KeyManager } from './KeyManager.js'
import { BlindedMessage, BlindSignature, Proof } from '../../types/cashu.js'
import {
  InvalidProofError,
  KeysetInactiveError,
  KeysetUnitMismatchError,
  MintError,
} from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { Point } from '@noble/secp256k1'
import { createHash } from 'crypto'
import { createDLEQProof, pointFromHex as cashuPointFromHex } from '@cashu/cashu-ts'

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

// Cashu's hash_to_curve implementation
const DOMAIN_SEPARATOR = new Uint8Array([
  83, 101, 99, 112, 50, 53, 54, 107, 49, 95, 72, 97, 115, 104, 84, 111, 67, 117, 114, 118, 101, 95,
  67, 97, 115, 104, 117, 95,
])

function hashToCurve(message: string): Point {
  const msgToHash = sha256(new Uint8Array([...DOMAIN_SEPARATOR, ...new TextEncoder().encode(message)]))

  for (let counter = 0; counter < 2 ** 16; counter++) {
    const counterBytes = new Uint8Array(4)
    new DataView(counterBytes.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgToHash, ...counterBytes]))

    try {
      const point = Point.fromHex('02' + Buffer.from(hash).toString('hex'))
      return point
    } catch {
      continue
    }
  }

  throw new Error('Could not hash to curve')
}

function pointFromHex(hex: string): Point {
  return Point.fromHex(hex)
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export class MintCrypto {
  constructor(private keyManager: KeyManager) {}

  /**
   * Sign a blinded message (NUT-00)
   * C_ = k * B_
   */
  async signBlindedMessage(message: BlindedMessage, includeDleq: boolean = true): Promise<BlindSignature> {
    try {
      // Get private key for this amount/keyset
      const privateKeyHex = await this.keyManager.getPrivateKey(message.id, message.amount)
      const k = BigInt('0x' + privateKeyHex)

      // Parse blinded message point
      const B_ = pointFromHex(message.B_)

      // Sign: C_ = k * B_
      const C_ = B_.multiply(k)

      const signature: BlindSignature = {
        id: message.id,
        amount: message.amount,
        C_: C_.toHex(true), // Compressed format
      }

      if (includeDleq) {
        const dleq = createDLEQProof(cashuPointFromHex(message.B_), Buffer.from(privateKeyHex, 'hex'))
        signature.dleq = {
          e: bytesToHex(dleq.e),
          s: bytesToHex(dleq.s),
        }
      }

      return signature
    } catch (err) {
      logger.error({ err, message }, 'Failed to sign blinded message')
      throw new Error(`Failed to sign blinded message: ${(err as Error).message}`)
    }
  }

  /**
   * Sign multiple blinded messages (batch operation)
   */
  async signBlindedMessages(
    messages: BlindedMessage[],
    includeDleq: boolean = true
  ): Promise<BlindSignature[]> {
    return Promise.all(messages.map((msg) => this.signBlindedMessage(msg, includeDleq)))
  }

  async getKeysetUnit(keysetId: string): Promise<string> {
    const keyset = await this.keyManager.getPublicKeys(keysetId)
    if (!keyset.active) {
      throw new KeysetInactiveError(keysetId)
    }

    return keyset.unit
  }

  async ensureProofsUseUnit(proofs: Array<Pick<Proof, 'id'>>, unit: string): Promise<void> {
    for (const proof of proofs) {
      const keysetUnit = await this.getKeysetUnit(proof.id)
      if (keysetUnit !== unit) {
        throw new KeysetUnitMismatchError(unit, keysetUnit, proof.id)
      }
    }
  }

  async ensureOutputsUseUnit(
    outputs: Array<Pick<BlindedMessage, 'id'>>,
    unit: string
  ): Promise<void> {
    for (const output of outputs) {
      const keysetUnit = await this.getKeysetUnit(output.id)
      if (keysetUnit !== unit) {
        throw new KeysetUnitMismatchError(unit, keysetUnit, output.id)
      }
    }
  }

  async ensureProofsAndOutputsUseSingleUnit(
    proofs: Array<Pick<Proof, 'id'>>,
    outputs: Array<Pick<BlindedMessage, 'id'>>
  ): Promise<string> {
    if (proofs.length === 0) {
      throw new MintError('Swap requires input proofs', 11002, 'inputs=0')
    }

    const unit = await this.getKeysetUnit(proofs[0].id)
    await this.ensureProofsUseUnit(proofs, unit)
    await this.ensureOutputsUseUnit(outputs, unit)

    return unit
  }

  /**
   * Verify a proof is valid (NUT-00)
   * Checks: C == k * hash_to_curve(secret)
   */
  async verifyProof(proof: Proof): Promise<boolean> {
    try {
      // Get private key
      const privateKeyHex = await this.keyManager.getPrivateKey(proof.id, proof.amount)
      const k = BigInt('0x' + privateKeyHex)

      // Hash secret to curve point
      const Y = hashToCurve(proof.secret)

      // Calculate expected C: C = k * Y
      const expectedC = Y.multiply(k)

      // Parse provided C
      const providedC = pointFromHex(proof.C)

      // Compare
      const isValid = expectedC.equals(providedC)

      if (!isValid) {
        logger.error({
          keysetId: proof.id,
          amount: proof.amount,
          expectedC: expectedC.toHex(true),
          providedC: providedC.toHex(true),
          secret: proof.secret.substring(0, 16) + '...'
        }, 'Proof signature mismatch')
      }

      return isValid
    } catch (err) {
      logger.error({ err, proof }, 'Proof verification failed with exception')
      return false
    }
  }

  /**
   * Verify multiple proofs (batch operation)
   */
  async verifyProofs(proofs: Proof[]): Promise<boolean> {
    const results = await Promise.all(proofs.map((proof) => this.verifyProof(proof)))
    return results.every((result) => result)
  }

  /**
   * Verify proofs and throw on first invalid
   */
  async verifyProofsOrThrow(proofs: Proof[]): Promise<void> {
    for (const proof of proofs) {
      if (!(await this.verifyProof(proof))) {
        throw new InvalidProofError(`Invalid signature for proof with secret: ${proof.secret}`)
      }
    }
  }

  /**
   * Hash secret to curve point Y (for database lookup)
   * Returns hex-encoded compressed point
   */
  hashSecret(secret: string): string {
    const Y = hashToCurve(secret)
    return Y.toHex(true)
  }

  /**
   * Hash multiple secrets (batch operation)
   */
  hashSecrets(secrets: string[]): string[] {
    return secrets.map((secret) => this.hashSecret(secret))
  }

  /**
   * Calculate total amount from proofs
   */
  sumProofs(proofs: Proof[]): number {
    return proofs.reduce((sum, proof) => sum + proof.amount, 0)
  }

  async calculateInputFees(proofs: Array<Pick<Proof, 'id'>>): Promise<number> {
    let feePpk = 0

    for (const proof of proofs) {
      feePpk += await this.keyManager.getInputFeePpk(proof.id)
    }

    return Math.ceil(feePpk / 1000)
  }

  /**
   * Check if amount matches sum of proofs
   */
  verifyAmount(proofs: Proof[], expectedAmount: number): boolean {
    const total = this.sumProofs(proofs)
    return total === expectedAmount
  }
}
