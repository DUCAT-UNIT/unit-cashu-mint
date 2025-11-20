import * as bitcoin from 'bitcoinjs-lib'
import { EsploraClient } from './api-client.js'
import { encodeRunestone } from './runestone-encoder.js'
import { RuneUtxo, SatUtxo, RuneEdict, RUNES_TX_CONSTANTS } from './types.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * Get Bitcoin network configuration
 */
function getNetwork(): bitcoin.Network {
  switch (env.NETWORK) {
    case 'mainnet':
      return bitcoin.networks.bitcoin
    case 'testnet':
    case 'signet':
    case 'mutinynet':
      return bitcoin.networks.testnet
    default:
      return bitcoin.networks.testnet
  }
}

export class RunesPsbtBuilder {
  constructor(private esploraClient: EsploraClient) {}

  /**
   * Build a PSBT for a Runes transfer
   *
   * PSBT Structure:
   * Inputs:
   *   [0] P2WPKH (fee payment from SegWit address)
   *   [1...N] Taproot (rune-bearing UTXOs, can be multiple)
   *
   * Outputs:
   *   [0] Taproot return address (gets unallocated runes)
   *   [1] Recipient (gets specified runes via edict)
   *   [2] SegWit change (gets leftover sats, optional if > dust)
   *   [3] OP_RETURN (runestone with edict, always last)
   */
  async buildRunesPsbt(
    runeUtxos: RuneUtxo[],
    satUtxo: SatUtxo,
    taprootAddress: string,
    taprootInternalPubkey: string,
    segwitAddress: string,
    recipientAddress: string,
    amountInRunes: bigint
  ): Promise<{ psbt: bitcoin.Psbt; fee: number }> {
    const network = getNetwork()
    const psbt = new bitcoin.Psbt({ network })

    try {
      // amountInRunes is already in smallest units (e.g., 192143 for 1921.43 UNIT)
      const runeAmount = amountInRunes

      // Calculate transaction economics
      const fee = RUNES_TX_CONSTANTS.FEE
      const recipientSats = RUNES_TX_CONSTANTS.RECIPIENT_SATS
      const runeReturnSats = RUNES_TX_CONSTANTS.RUNE_RETURN_SATS
      const dustLimit = RUNES_TX_CONSTANTS.DUST_LIMIT

      // Calculate total input sats from all rune UTXOs
      const totalRuneSats = runeUtxos.reduce((sum, utxo) => sum + utxo.value, 0)

      // Calculate change
      const totalInput = satUtxo.value + totalRuneSats
      const totalOutput = fee + recipientSats + runeReturnSats
      const change = totalInput - totalOutput

      logger.info(
        {
          runeUtxoCount: runeUtxos.length,
          totalInput,
          totalOutput,
          fee,
          recipientSats,
          runeReturnSats,
          change,
        },
        'Building Runes PSBT with multiple inputs'
      )

      // Input 0: P2WPKH (fee payment from SegWit address)
      const satTxHex = await this.esploraClient.getTransactionHex(satUtxo.txid)
      const satTx = bitcoin.Transaction.fromHex(satTxHex)

      psbt.addInput({
        hash: satUtxo.txid,
        index: satUtxo.vout,
        witnessUtxo: {
          script: satTx.outs[satUtxo.vout].script,
          value: satUtxo.value,
        },
      })

      // Inputs 1...N: Taproot rune-bearing UTXOs
      for (const runeUtxo of runeUtxos) {
        const runeTxHex = await this.esploraClient.getTransactionHex(runeUtxo.txid)
        const runeTx = bitcoin.Transaction.fromHex(runeTxHex)

        psbt.addInput({
          hash: runeUtxo.txid,
          index: runeUtxo.vout,
          witnessUtxo: {
            script: runeTx.outs[runeUtxo.vout].script,
            value: runeUtxo.value,
          },
          tapInternalKey: Buffer.from(taprootInternalPubkey, 'hex'),
        })
      }

      // Output 0: Taproot return address (unallocated runes go here)
      psbt.addOutput({
        address: taprootAddress,
        value: runeReturnSats,
      })

      // Output 1: Recipient (gets specified runes via edict)
      psbt.addOutput({
        address: recipientAddress,
        value: recipientSats,
      })

      // Output 2: SegWit change (optional, only if above dust)
      if (change >= dustLimit) {
        psbt.addOutput({
          address: segwitAddress,
          value: change,
        })
      }

      // Output 3 (or 4): OP_RETURN runestone (always last)
      // IMPORTANT: Calculate total runes from all inputs (already in smallest units)
      const totalRunesFromUtxos = runeUtxos.reduce((sum, utxo) => sum + utxo.runeAmount, 0n)

      // CRITICAL: Use REQUESTED amount in edict, NOT total from UTXOs
      // Excess runes will go to output 0 (taproot return address)
      const edict: RuneEdict = {
        id: runeUtxos[0].runeId,
        amount: runeAmount, // This is the REQUESTED amount, not totalRunesFromUtxos
        output: 1, // Recipient is at output index 1
      }

      logger.info({
        requestedAmount: runeAmount.toString(),
        totalFromUtxos: totalRunesFromUtxos.toString(),
        excess: (totalRunesFromUtxos - runeAmount).toString()
      }, 'Edict using REQUESTED amount, excess returns to mint')

      const { encodedRunestone } = encodeRunestone({ edicts: [edict] })

      psbt.addOutput({
        script: encodedRunestone,
        value: 0,
      })

      logger.info(
        {
          inputs: psbt.data.inputs.length,
          outputs: psbt.data.outputs.length,
          runeAmount: runeAmount.toString(),
          runeAmountDisplay: amountInRunes.toString(),
          recipient: recipientAddress,
        },
        'PSBT built successfully'
      )

      return { psbt, fee }
    } catch (error) {
      logger.error({ error }, 'Error building Runes PSBT')
      throw error
    }
  }
}
