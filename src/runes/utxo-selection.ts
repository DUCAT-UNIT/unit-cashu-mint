import { OrdClient, EsploraClient } from './api-client.js'
import { RuneUtxo, SatUtxo, RUNES_TX_CONSTANTS, RuneId } from './types.js'
import { logger } from '../utils/logger.js'

export class UtxoSelector {
  constructor(
    private ordClient: OrdClient,
    private esploraClient: EsploraClient
  ) {}

  /**
   * Find a Rune UTXO with sufficient runes
   * @param address The taproot address to search
   * @param requiredAmount Minimum rune amount needed
   * @param runeName Name of the rune (e.g., "DUCAT•UNIT•RUNE")
   * @param runeId Rune ID { block, tx }
   * @param spentUtxos Set of spent UTXO keys "txid:vout" to exclude
   * @returns RuneUtxo or null if not found
   */
  async findRuneUtxo(
    address: string,
    requiredAmount: bigint,
    runeName: string,
    runeId: RuneId,
    spentUtxos: Set<string> = new Set()
  ): Promise<RuneUtxo | null> {
    try {
      // Get all outputs for this address from Ord
      const ordData = await this.ordClient.getAddressOutputs(address)

      // Check each output for runes
      for (const output of ordData.outputs) {
        const [txid, voutStr] = output.split(':')
        const vout = parseInt(voutStr, 10)
        const utxoKey = `${txid}:${vout}`

        // Skip if already spent
        if (spentUtxos.has(utxoKey)) {
          continue
        }

        // Get detailed info about this output
        const outputData = await this.ordClient.getOutput(txid, vout)

        // Check if it has the required rune
        if (outputData.runes && outputData.runes[runeName]) {
          const runeData = outputData.runes[runeName]
          const runeAmount = BigInt(runeData.amount)

          // Check if this UTXO has enough runes
          if (runeAmount >= requiredAmount) {
            // Verify it's not spent on the blockchain
            const outspend = await this.esploraClient.getOutspend(txid, vout)

            if (!outspend.spent) {
              logger.info(
                { txid, vout, runeAmount: runeAmount.toString(), requiredAmount: requiredAmount.toString() },
                'Found suitable rune UTXO'
              )

              return {
                txid,
                vout,
                value: outputData.value,
                address,
                runeAmount,
                runeName,
                runeId,
              }
            }
          }
        }
      }

      logger.warn({ address, requiredAmount: requiredAmount.toString(), runeName }, 'No suitable rune UTXO found')
      return null
    } catch (error) {
      logger.error({ error, address, runeName }, 'Error finding rune UTXO')
      throw error
    }
  }

  /**
   * Find a sat UTXO for paying fees
   * @param address The segwit address to search for fee UTXOs
   * @param spentUtxos Set of spent UTXO keys "txid:vout" to exclude
   * @returns SatUtxo or null if not found
   */
  async findSatUtxo(
    address: string,
    spentUtxos: Set<string> = new Set()
  ): Promise<SatUtxo | null> {
    try {
      // Get all UTXOs for this address from Esplora
      const utxos = await this.esploraClient.getAddressUtxos(address)

      // Find the first confirmed UTXO with enough sats
      for (const utxo of utxos) {
        const utxoKey = `${utxo.txid}:${utxo.vout}`

        // Skip if already spent
        if (spentUtxos.has(utxoKey)) {
          continue
        }

        // Check if confirmed and has enough sats
        if (utxo.status.confirmed && utxo.value >= RUNES_TX_CONSTANTS.MIN_SAT_UTXO) {
          logger.info(
            { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
            'Found suitable sat UTXO for fees'
          )

          return {
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            address,
            confirmations: utxo.status.block_height ? 1 : 0, // Simplified
          }
        }
      }

      logger.warn({ address, minSats: RUNES_TX_CONSTANTS.MIN_SAT_UTXO }, 'No suitable sat UTXO found')
      return null
    } catch (error) {
      logger.error({ error, address }, 'Error finding sat UTXO')
      throw error
    }
  }

  /**
   * Find both rune and sat UTXOs needed for a runes transaction
   */
  async findUtxosForRunesTransfer(
    taprootAddress: string,
    segwitAddress: string,
    requiredRunes: bigint,
    runeName: string,
    runeId: RuneId,
    spentUtxos: Set<string> = new Set()
  ): Promise<{ runeUtxo: RuneUtxo; satUtxo: SatUtxo } | null> {
    const runeUtxo = await this.findRuneUtxo(
      taprootAddress,
      requiredRunes,
      runeName,
      runeId,
      spentUtxos
    )

    if (!runeUtxo) {
      return null
    }

    const satUtxo = await this.findSatUtxo(segwitAddress, spentUtxos)

    if (!satUtxo) {
      return null
    }

    return { runeUtxo, satUtxo }
  }
}
