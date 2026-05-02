import { OrdClient } from '../../src/runes/api-client.js'
import { EsploraClient } from '../../src/runes/api-client.js'
import { env } from '../../src/config/env.js'

async function debug() {
  const ordClient = new OrdClient(env.ORD_URL)
  const esploraClient = new EsploraClient(env.ESPLORA_URL)

  const address = 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em'

  console.log('Checking ORD API for address outputs...')
  console.log('ORD_URL:', env.ORD_URL)

  try {
    const ordData = await ordClient.getAddressOutputs(address)
    console.log('\n=== Ord Address Data ===')
    console.log('Outputs count:', ordData.outputs?.length ?? 0)
    console.log('Runes balances:', JSON.stringify(ordData.runes_balances, null, 2))

    if (ordData.outputs && ordData.outputs.length > 0) {
      console.log('\nFirst 5 outputs:')
      for (const output of ordData.outputs.slice(0, 5)) {
        console.log(' -', output)

        // Check this output's runes
        const [txid, voutStr] = output.split(':')
        const vout = parseInt(voutStr, 10)

        try {
          const utxoDetails = await ordClient.getOutput(txid, vout)
          console.log('   Runes:', utxoDetails?.runes ? Object.keys(utxoDetails.runes) : 'none')
        } catch (e: any) {
          console.log('   Error getting output:', e.message)
        }
      }
    }

    // Check specific txid from your deposit
    const txid = 'a3ab2377d008970b27b0a0b98cb70cdd0173d7dea7bc061d3d7595b07cf64dd0'
    const vout = 1

    console.log(`\n=== Checking specific output ${txid}:${vout} ===`)
    const utxoDetails = await ordClient.getOutput(txid, vout)
    console.log('UTXO details:', JSON.stringify(utxoDetails, null, 2))

    // Check transaction
    const tx = await esploraClient.getTransaction(txid)
    console.log('\nTransaction status:', tx.status)

    const blockHeight = await esploraClient.getBlockHeight()
    const confirmations = tx.status.confirmed && tx.status.block_height
      ? blockHeight - tx.status.block_height + 1
      : 0
    console.log('Confirmations:', confirmations)

  } catch (e: any) {
    console.error('Error:', e.message)
    console.error(e.stack)
  }
}

debug()
