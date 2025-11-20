import { OrdClient, EsploraClient } from './api-client.js'
import { RuneUtxo, SatUtxo, RUNES_TX_CONSTANTS, RuneId } from './types.js'
import { logger } from '../utils/logger.js'

export class UtxoSelector {
  constructor(
    private ordClient: OrdClient,
    private esploraClient: EsploraClient
  ) {}

  /**
   * Find Rune UTXOs with sufficient runes (can combine multiple)
   * @param address The taproot address to search
   * @param requiredAmount Minimum rune amount needed
   * @param runeName Name of the rune (e.g., "DUCAT•UNIT•RUNE")
   * @param runeId Rune ID { block, tx }
   * @param spentUtxos Set of spent UTXO keys "txid:vout" to exclude
   * @returns Array of RuneUtxos or null if not found
   */
  async findRuneUtxos(
    address: string,
    requiredAmount: bigint,
    runeName: string,
    runeId: RuneId,
    spentUtxos: Set<string> = new Set()
  ): Promise<RuneUtxo[] | null> {
    try {
      // Get all outputs for this address from Ord
      const ordData = await this.ordClient.getAddressOutputs(address)

      const runeUtxos: RuneUtxo[] = []
      let totalAmount = 0n

      // Collect UTXOs until we have enough runes
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

          // Verify it's not spent on the blockchain
          const outspend = await this.esploraClient.getOutspend(txid, vout)

          if (!outspend.spent) {
            runeUtxos.push({
              txid,
              vout,
              value: outputData.value,
              address,
              runeAmount,
              runeName,
              runeId,
            })

            totalAmount += runeAmount

            // Check if we have enough now
            if (totalAmount >= requiredAmount) {
              logger.info(
                {
                  utxoCount: runeUtxos.length,
                  totalAmount: totalAmount.toString(),
                  requiredAmount: requiredAmount.toString()
                },
                'Found sufficient rune UTXOs'
              )
              return runeUtxos
            }
          }
        }
      }

      // If we get here, we didn't find enough
      logger.warn({
        address,
        requiredAmount: requiredAmount.toString(),
        totalFound: totalAmount.toString(),
        utxoCount: runeUtxos.length,
        runeName
      }, 'Insufficient rune UTXOs found')
      return null
    } catch (error) {
      logger.error({ error, address, runeName }, 'Error finding rune UTXOs')
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
  ): Promise<{ runeUtxos: RuneUtxo[]; satUtxo: SatUtxo } | null> {
    const runeUtxos = await this.findRuneUtxos(
      taprootAddress,
      requiredRunes,
      runeName,
      runeId,
      spentUtxos
    )

    if (!runeUtxos) {
      return null
    }

    const satUtxo = await this.findSatUtxo(segwitAddress, spentUtxos)

    if (!satUtxo) {
      return null
    }

    return { runeUtxos, satUtxo }
  }
}
