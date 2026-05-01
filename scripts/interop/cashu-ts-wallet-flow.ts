import assert from 'node:assert/strict'
import {
  MintQuoteState,
  Wallet,
  sumProofs,
  type MintInfo,
  type MintQuoteBolt11Response,
  type Proof,
} from '@cashu/cashu-ts'

const DEFAULT_MELT_INVOICE =
  'lnbcrt620n1pn0r3vepp5zljn7g09fsyeahl4rnhuy0xax2puhua5r3gspt7ttlfrley6valqdqqcqzzsxqyz5vqsp577h763sel3q06tfnfe75kvwn5pxn344sd5vnays65f9wfgx4fpzq9qxpqysgqg3re9afz9rwwalytec04pdhf9mvh3e2k4r877tw7dr4g0fvzf9sny5nlfggdy6nduy2dytn06w50ls34qfldgsj37x0ymxam0a687mspp0ytr8'

const mintUrl = process.env.MINT_URL ?? 'http://127.0.0.1:3338'
const mintAmount = Number(process.env.MINT_AMOUNT ?? '128')
const sendAmount = Number(process.env.SEND_AMOUNT ?? '21')
const meltInvoice = process.env.MELT_INVOICE ?? DEFAULT_MELT_INVOICE

function amount(proofs: Proof[]): number {
  return sumProofs(proofs).toNumber()
}

async function waitForMint(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error(`Mint did not become ready: ${url}`)
}

async function waitForPaid(
  wallet: Wallet,
  quote: MintQuoteBolt11Response
): Promise<MintQuoteBolt11Response> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const checked = await wallet.checkMintQuoteBolt11(quote)
    if (checked.state === MintQuoteState.PAID) {
      return checked
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Mint quote did not become PAID: ${quote.quote}`)
}

function assertMintInfo(info: MintInfo): void {
  const raw = info.cache
  const mintMethods = raw.nuts[4]?.methods ?? []
  const meltMethods = raw.nuts[5]?.methods ?? []

  assert(
    mintMethods.some((method) => method.method === 'bolt11' && method.unit === 'sat'),
    'mint info must advertise bolt11/sat minting'
  )
  assert(
    meltMethods.some((method) => method.method === 'bolt11' && method.unit === 'sat'),
    'mint info must advertise bolt11/sat melting'
  )
  assert.equal(raw.nuts[8]?.supported, true, 'mint info must advertise NUT-08')
}

await waitForMint(mintUrl)

const wallet = new Wallet(mintUrl, { unit: 'sat' })
await wallet.loadMint()
assertMintInfo(wallet.getMintInfo())

const quote = await wallet.createMintQuoteBolt11(mintAmount)
const paidQuote = await waitForPaid(wallet, quote)
const proofs = await wallet.mintProofsBolt11(mintAmount, paidQuote)
assert.equal(amount(proofs), mintAmount)

const sent = await wallet.send(sendAmount, proofs)
assert.equal(amount(sent.send), sendAmount)
assert.equal(amount(sent.keep), mintAmount - sendAmount)

const meltQuote = await wallet.createMeltQuoteBolt11(meltInvoice)
const meltTotal = meltQuote.amount.add(meltQuote.fee_reserve).toNumber()
const selectedForMelt = await wallet.send(meltTotal, sent.keep, { includeFees: true })
assert.equal(amount(selectedForMelt.send), meltTotal)

const melt = await wallet.meltProofsBolt11(meltQuote, selectedForMelt.send)
assert.equal(melt.quote.state, 'PAID')
assert.equal(amount(melt.change), meltQuote.fee_reserve.toNumber())

const remaining = amount(selectedForMelt.keep) + amount(melt.change)
assert.equal(remaining, mintAmount - sendAmount - meltQuote.amount.toNumber())

console.log(
  JSON.stringify(
    {
      mintUrl,
      minted: amount(proofs),
      sent: amount(sent.send),
      melted: meltQuote.amount.toNumber(),
      feeReserveReturned: amount(melt.change),
      remaining,
    },
    null,
    2
  )
)
