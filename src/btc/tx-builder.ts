import * as bitcoin from 'bitcoinjs-lib'
import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { BTCUtxo } from './types.js'
import { logger } from '../utils/logger.js'
import { env } from '../config/env.js'

// Initialize BIP32 and ECC library
const bip32 = BIP32Factory(ecc)
bitcoin.initEccLib(ecc)

/**
 * Get Bitcoin network configuration based on environment
 */
function getNetwork(networkName: string = env.NETWORK): bitcoin.Network {
  switch (networkName) {
    case 'mainnet':
      return bitcoin.networks.bitcoin
    case 'testnet':
    case 'signet':
    case 'mutinynet':
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

export interface BTCTransactionResult {
  psbt: bitcoin.Psbt
  fee: number
  txSize: number
  selectedUtxos: BTCUtxo[]
}

/**
 * Simple Bitcoin transaction builder for P2WPKH transactions
 */
export class BTCTxBuilder {
  private network: bitcoin.Network

  constructor(networkName?: string) {
    this.network = getNetwork(networkName)
  }

  /**
   * Estimate transaction size for fee calculation
   * P2WPKH input: ~68 vbytes
   * P2WPKH output: ~31 vbytes
   * Overhead: ~10 vbytes
   */
  estimateTxSize(inputCount: number, outputCount: number): number {
    const inputSize = 68 * inputCount
    const outputSize = 31 * outputCount
    const overhead = 10
    return inputSize + outputSize + overhead
  }

  /**
   * Build a simple BTC transaction
   * @param utxos - Available UTXOs to spend
   * @param destination - Destination address
   * @param amount - Amount to send in satoshis
   * @param changeAddress - Address for change
   * @param feeRate - Fee rate in sats/vbyte
   */
  buildTransaction(
    utxos: BTCUtxo[],
    destination: string,
    amount: bigint,
    changeAddress: string,
    feeRate: number
  ): BTCTransactionResult {
    const psbt = new bitcoin.Psbt({ network: this.network })

    // Sort UTXOs by value (largest first) for efficient selection
    const sortedUtxos = [...utxos].sort((a, b) => b.value - a.value)

    // Select UTXOs to cover amount + estimated fee
    let selectedValue = 0n
    const selectedUtxos: BTCUtxo[] = []

    // Initial fee estimate (1 input, 2 outputs)
    let estimatedFee = this.estimateTxSize(1, 2) * feeRate

    for (const utxo of sortedUtxos) {
      selectedUtxos.push(utxo)
      selectedValue += BigInt(utxo.value)

      // Recalculate fee with current input count
      estimatedFee = this.estimateTxSize(selectedUtxos.length, 2) * feeRate

      if (selectedValue >= amount + BigInt(estimatedFee)) {
        break
      }
    }

    if (selectedValue < amount + BigInt(estimatedFee)) {
      throw new Error(
        `Insufficient funds: have ${selectedValue} sats, need ${amount + BigInt(estimatedFee)} sats (including ${estimatedFee} sats fee)`
      )
    }

    // Add inputs
    for (const utxo of selectedUtxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: bitcoin.address.toOutputScript(utxo.address, this.network),
          value: utxo.value,
        },
      })
    }

    // Add recipient output
    psbt.addOutput({
      address: destination,
      value: Number(amount),
    })

    // Calculate change
    const change = selectedValue - amount - BigInt(estimatedFee)

    // Add change output if above dust threshold (546 sats)
    if (change > 546n) {
      psbt.addOutput({
        address: changeAddress,
        value: Number(change),
      })
    } else {
      // Add dust to fee
      estimatedFee += Number(change)
    }

    logger.info(
      {
        inputs: selectedUtxos.length,
        totalInput: selectedValue.toString(),
        amount: amount.toString(),
        fee: estimatedFee,
        change: change.toString(),
      },
      'BTC transaction built'
    )

    return {
      psbt,
      fee: estimatedFee,
      txSize: this.estimateTxSize(selectedUtxos.length, change > 546n ? 2 : 1),
      selectedUtxos,
    }
  }

  /**
   * Sign a BTC transaction PSBT
   * @param psbt - The PSBT to sign
   * @param accountIndex - The account index for key derivation
   */
  signTransaction(
    psbt: bitcoin.Psbt,
    selectedUtxos?: BTCUtxo[],
    accountIndex: number = 0
  ): bitcoin.Psbt {
    const seed = Buffer.from(env.MINT_SEED, 'hex')
    const root = bip32.fromSeed(seed, this.network)

    // Sign all inputs
    for (let i = 0; i < psbt.data.inputs.length; i++) {
      const inputAccountIndex = selectedUtxos?.[i]?.accountIndex ?? accountIndex
      const segwitPath = `m/84'/1'/0'/0/${inputAccountIndex}`
      const segwitChild = root.derivePath(segwitPath)
      const signer: bitcoin.Signer = {
        publicKey: Buffer.from(segwitChild.publicKey),
        sign: (hash: Buffer) => {
          const sig = segwitChild.sign(hash)
          return Buffer.from(sig)
        },
      }

      psbt.signInput(i, signer)
    }

    psbt.finalizeAllInputs()

    logger.info({ inputs: psbt.data.inputs.length }, 'BTC PSBT signed')

    return psbt
  }

  /**
   * Sign and extract transaction
   */
  signAndExtract(
    psbt: bitcoin.Psbt,
    selectedUtxos?: BTCUtxo[],
    accountIndex: number = 0
  ): { signedTxHex: string; txid: string } {
    const signedPsbt = this.signTransaction(psbt, selectedUtxos, accountIndex)
    const tx = signedPsbt.extractTransaction()

    return {
      signedTxHex: tx.toHex(),
      txid: tx.getId(),
    }
  }

  /**
   * Get the Bitcoin network
   */
  getNetwork(): bitcoin.Network {
    return this.network
  }
}
