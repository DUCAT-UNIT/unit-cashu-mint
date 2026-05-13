import * as bitcoin from 'bitcoinjs-lib'
import { BIP32Factory, BIP32Interface } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import { logger } from '../utils/logger.js'
import { env } from '../config/env.js'

// Initialize BIP32 and ECC library
const bip32 = BIP32Factory(ecc)
bitcoin.initEccLib(ecc)

/**
 * Get Bitcoin network configuration based on environment
 */
function getNetwork(): bitcoin.Network {
  switch (env.NETWORK) {
    case 'mainnet':
      return bitcoin.networks.bitcoin
    case 'testnet':
    case 'signet':
    case 'mutinynet':
      // Mutinynet signet network configuration
      return {
        messagePrefix: '\x18Bitcoin Signed Message:\n',
        bech32: 'tb',
        bip32: {
          public: 0x043587cf,
          private: 0x04358394,
        },
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef,
      }
    case 'regtest':
      return bitcoin.networks.regtest
    default:
      return bitcoin.networks.testnet
  }
}

export interface DerivedKeys {
  segwitChild: BIP32Interface
  taprootChild: BIP32Interface
}

export interface MintAddresses {
  segwitAddress: string
  taprootAddress: string
  segwitPubkey: string
  taprootPubkey: string
}

export interface DerivedTaprootAddress {
  address: string
  accountIndex: number
  internalPubkey: string
}

/**
 * Wallet Key Manager for the Mint
 * Handles key derivation, address generation, and PSBT signing
 * SECURITY-CRITICAL: Manages mnemonic/seed exposure
 */
export class WalletKeyManager {
  private network: bitcoin.Network
  private accountIndex: number

  constructor(accountIndex: number = 0) {
    this.network = getNetwork()
    this.accountIndex = accountIndex
  }

  /**
   * Derive addresses from MINT_SEED
   * This should be called once during mint initialization
   */
  deriveAddresses(): MintAddresses {
    const root = this.rootFromSeed()

    // BIP84 - Native SegWit (for fee payments)
    const segwitPath = `m/84'/1'/0'/0/${this.accountIndex}`
    const segwitChild = root.derivePath(segwitPath)
    const segwitPayment = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(segwitChild.publicKey),
      network: this.network,
    })

    // BIP86 - Taproot (for receiving runes)
    const taprootPath = `m/86'/1'/0'/0/${this.accountIndex}`
    const taprootChild = root.derivePath(taprootPath)
    const xOnlyPubkey = Buffer.from(taprootChild.publicKey.slice(1, 33))
    const taprootPayment = bitcoin.payments.p2tr({
      internalPubkey: xOnlyPubkey,
      network: this.network,
    })

    if (!segwitPayment.address || !taprootPayment.address) {
      throw new Error('Failed to derive addresses')
    }

    logger.info(
      {
        segwitAddress: segwitPayment.address,
        taprootAddress: taprootPayment.address,
        network: env.NETWORK,
      },
      'Mint addresses derived'
    )

    return {
      segwitAddress: segwitPayment.address,
      taprootAddress: taprootPayment.address,
      segwitPubkey: Buffer.from(segwitChild.publicKey).toString('hex'),
      taprootPubkey: xOnlyPubkey.toString('hex'),
    }
  }

  deriveQuoteTaprootAddress(quoteId: string): DerivedTaprootAddress {
    return this.deriveTaprootAddress(this.quoteAccountIndex(quoteId))
  }

  deriveTaprootAddress(accountIndex: number = this.accountIndex): DerivedTaprootAddress {
    const root = this.rootFromSeed()
    const taprootChild = root.derivePath(`m/86'/1'/0'/0/${accountIndex}`)
    const xOnlyPubkey = Buffer.from(taprootChild.publicKey.slice(1, 33))
    const taprootPayment = bitcoin.payments.p2tr({
      internalPubkey: xOnlyPubkey,
      network: this.network,
    })

    if (!taprootPayment.address) {
      throw new Error('Failed to derive Taproot address')
    }

    return {
      address: taprootPayment.address,
      accountIndex,
      internalPubkey: xOnlyPubkey.toString('hex'),
    }
  }

  quoteAccountIndex(quoteId: string): number {
    if (!quoteId) {
      return 0
    }

    const maxNonHardenedIndex = 0x7fffffff
    const digest = createHash('sha256').update(quoteId).digest()
    return (digest.readUInt32BE(0) % maxNonHardenedIndex) + 1
  }

  /**
   * Derive signing keys from MINT_SEED
   * SECURITY: Seed is only in memory for the duration of this function
   */
  private deriveSigningKeys(accountIndex: number = this.accountIndex): DerivedKeys {
    const root = this.rootFromSeed()

    // Derive all keys we need
    const segwitChild = root.derivePath(`m/84'/1'/0'/0/${this.accountIndex}`)
    const taprootChild = root.derivePath(`m/86'/1'/0'/0/${accountIndex}`)

    // Note: seed and root are destroyed when this function returns
    return {
      segwitChild,
      taprootChild,
    }
  }

  /**
   * Sign a Runes transaction PSBT
   * @param psbt - The PSBT to sign
   * @returns Signed PSBT
   */
  signRunesPsbt(psbt: bitcoin.Psbt, runeInputAccountIndexes: number[] = []): bitcoin.Psbt {
    try {
      // Derive signing keys
      const { segwitChild } = this.deriveSigningKeys()

      // RUNES transactions have mixed input types:
      // - Input 0: P2WPKH (fee input from SegWit balance)
      // - Inputs 1...N: Taproot (rune inputs with UNIT balance, can be multiple)

      // Create a wrapper for segwitChild that converts Uint8Array to Buffer
      const segwitSigner: bitcoin.Signer = {
        publicKey: Buffer.from(segwitChild.publicKey),
        sign: (hash: Buffer) => {
          const sig = segwitChild.sign(hash)
          return Buffer.from(sig)
        },
      }

      // Sign Input 0 with SegWit key
      psbt.signInput(0, segwitSigner)

      // Sign all taproot inputs (inputs 1 through N). Each rune input may come
      // from a different quote-derived Taproot address, so derive per input.
      const inputCount = psbt.data.inputs.length
      for (let i = 1; i < inputCount; i++) {
        const accountIndex = runeInputAccountIndexes[i - 1] ?? this.accountIndex
        const { taprootChild } = this.deriveSigningKeys(accountIndex)
        const tweakedSigner = taprootChild.tweak(
          bitcoin.crypto.taggedHash('TapTweak', Buffer.from(taprootChild.publicKey.slice(1, 33)))
        )

        const taprootSigner: bitcoin.Signer = {
          publicKey: Buffer.from(tweakedSigner.publicKey),
          sign: (hash: Buffer) => {
            const sig = tweakedSigner.sign(hash)
            return Buffer.from(sig)
          },
          signSchnorr: (hash: Buffer) => {
            const sig = tweakedSigner.signSchnorr(hash)
            return Buffer.from(sig)
          },
        }

        psbt.signInput(i, taprootSigner)
      }

      // Finalize all inputs
      psbt.finalizeAllInputs()

      logger.info({ inputs: psbt.data.inputs.length }, 'PSBT signed successfully')

      return psbt
    } catch (error) {
      logger.error(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        'Error signing PSBT'
      )
      throw error
    }
  }

  /**
   * Sign a PSBT and extract the transaction
   * @param psbt - The PSBT to sign
   * @returns Object with signed transaction hex and txid
   */
  signAndExtract(
    psbt: bitcoin.Psbt,
    runeInputAccountIndexes: number[] = []
  ): { signedTxHex: string; txid: string } {
    const signedPsbt = this.signRunesPsbt(psbt, runeInputAccountIndexes)

    // Extract signed transaction
    const signedTx = signedPsbt.extractTransaction()
    const signedTxHex = signedTx.toHex()
    const txid = signedTx.getId()

    // Verify runestone is present (basic sanity check)
    const hasRunestone = signedTx.outs.some((output) => {
      const scriptHex = output.script.toString('hex')
      return scriptHex.startsWith('6a5d') // OP_RETURN + OP_13 (Runes marker)
    })

    if (!hasRunestone) {
      logger.warn({ txid }, 'Warning: No runestone found in signed transaction')
    }

    logger.info(
      {
        txid,
        size: signedTxHex.length / 2,
        outputs: signedTx.outs.length,
        hasRunestone,
      },
      'Transaction extracted'
    )

    return { signedTxHex, txid }
  }

  /**
   * Get the Bitcoin network being used
   */
  getNetwork(): bitcoin.Network {
    return this.network
  }

  private rootFromSeed(): BIP32Interface {
    const seed = Buffer.from(env.MINT_SEED, 'hex')

    if (seed.length !== 32) {
      throw new Error('MINT_SEED must be 32 bytes (64 hex characters)')
    }

    return bip32.fromSeed(seed, this.network)
  }
}
