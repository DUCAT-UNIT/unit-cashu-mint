import { OrdClient, EsploraClient } from '../../src/runes/api-client.js'
import { env } from '../../src/config/env.js'

async function check() {
  const ordClient = new OrdClient(env.ORD_URL)
  const esploraClient = new EsploraClient(env.ESPLORA_URL)

  console.log('=== Checking New Deposits ===\n')

  // Check new UNIT output
  const unitTxid = '549e29c3151854a47f3aa6475a082ae75d0fa056e0cae2496f110269029b5f0d'
  console.log('UNIT Transaction:', unitTxid)

  try {
    const output = await ordClient.getOutput(unitTxid, 1)
    console.log('UNIT Output:', JSON.stringify(output?.runes, null, 2))
    if (output?.runes?.['DUCAT•UNIT•RUNE']) {
      console.log('UNIT Amount:', output.runes['DUCAT•UNIT•RUNE'].amount)
    }
  } catch (e: any) {
    console.log('Error checking UNIT:', e.message)
  }

  console.log('')

  // Check BTC UTXOs
  console.log('BTC Address UTXOs:')
  const btcUtxos = await esploraClient.getAddressUtxos('tb1q0ymavqheqw5ktk9k6l43an3njhcym8khmjlw36')
  for (const utxo of btcUtxos) {
    console.log(`  - ${utxo.txid.slice(0, 16)}... : ${utxo.value} sats (${utxo.status.confirmed ? 'confirmed' : 'unconfirmed'})`)
  }
}

check().catch(console.error)
