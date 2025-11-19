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
   *   [1] Taproot (rune-bearing UTXO)
   *
   * Outputs:
   *   [0] Taproot return address (gets unallocated runes)
   *   [1] Recipient (gets specified runes via edict)
   *   [2] SegWit change (gets leftover sats, optional if > dust)
   *   [3] OP_RETURN (runestone with edict, always last)
   */
  async buildRunesPsbt(
    runeUtxo: RuneUtxo,
    satUtxo: SatUtxo,
    taprootAddress: string,
    segwitAddress: string,
    recipientAddress: string,
    amountInRunes: bigint
  ): Promise<{ psbt: bitcoin.Psbt; fee: number }> {
    const network = getNetwork()
    const psbt = new bitcoin.Psbt({ network })

    try {
      // Calculate transaction economics
      const fee = RUNES_TX_CONSTANTS.FEE
      const recipientSats = RUNES_TX_CONSTANTS.RECIPIENT_SATS
      const runeReturnSats = RUNES_TX_CONSTANTS.RUNE_RETURN_SATS
      const dustLimit = RUNES_TX_CONSTANTS.DUST_LIMIT

      // Calculate change
      const totalInput = satUtxo.value + runeUtxo.value
      const totalOutput = fee + recipientSats + runeReturnSats
      const change = totalInput - totalOutput

      logger.info(
        {
          totalInput,
          totalOutput,
          fee,
          recipientSats,
          runeReturnSats,
          change,
        },
        'Building Runes PSBT'
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

      // Input 1: Taproot (rune-bearing UTXO)
      const runeTxHex = await this.esploraClient.getTransactionHex(runeUtxo.txid)
      const runeTx = bitcoin.Transaction.fromHex(runeTxHex)

      psbt.addInput({
        hash: runeUtxo.txid,
        index: runeUtxo.vout,
        witnessUtxo: {
          script: runeTx.outs[runeUtxo.vout].script,
          value: runeUtxo.value,
        },
        tapInternalKey: Buffer.from(
          taprootAddress.slice(taprootAddress.length - 64),
          'hex'
        ), // Simplified - should derive properly
      })

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
      const edict: RuneEdict = {
        id: runeUtxo.runeId,
        amount: amountInRunes,
        output: 1, // Recipient is at output index 1
      }

      const { encodedRunestone } = encodeRunestone({ edicts: [edict] })

      psbt.addOutput({
        script: encodedRunestone,
        value: 0,
      })

      logger.info(
        {
          inputs: psbt.data.inputs.length,
          outputs: psbt.data.outputs.length,
          runeAmount: amountInRunes.toString(),
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
