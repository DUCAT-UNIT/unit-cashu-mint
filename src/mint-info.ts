export interface MintInfoConfig {
  SUPPORTED_UNITS_ARRAY: string[]
  SUPPORTS_BITCOIN: boolean
  SUPPORTS_LIGHTNING: boolean
  MIN_MINT_AMOUNT: number
  MAX_MINT_AMOUNT: number
  MIN_MELT_AMOUNT: number
  MAX_MELT_AMOUNT: number
  MINT_CONFIRMATIONS: number
  MINT_NAME?: string
  MINT_PUBKEY?: string
  MINT_DESCRIPTION?: string
  MINT_CONTACT_EMAIL?: string
  MINT_CONTACT_NOSTR?: string
}

export function buildMintInfo(config: MintInfoConfig) {
  const mintMethods: Array<{
    method: string
    unit: string
    min_amount: number
    max_amount: number
    options?: Record<string, unknown>
  }> = []
  const meltMethods: Array<{
    method: string
    unit: string
    min_amount: number
    max_amount: number
    options?: Record<string, unknown>
  }> = []

  if (config.SUPPORTED_UNITS_ARRAY.includes('unit')) {
    mintMethods.push({
      method: 'onchain',
      unit: 'unit',
      min_amount: config.MIN_MINT_AMOUNT,
      max_amount: config.MAX_MINT_AMOUNT,
      options: {
        confirmations: config.MINT_CONFIRMATIONS,
      },
    })
    meltMethods.push({
      method: 'onchain',
      unit: 'unit',
      min_amount: config.MIN_MELT_AMOUNT,
      max_amount: config.MAX_MELT_AMOUNT,
    })
  }

  if (config.SUPPORTS_BITCOIN) {
    mintMethods.push({
      method: 'onchain',
      unit: 'sat',
      min_amount: config.MIN_MINT_AMOUNT,
      max_amount: config.MAX_MINT_AMOUNT,
      options: {
        confirmations: config.MINT_CONFIRMATIONS,
      },
    })
    meltMethods.push({
      method: 'onchain',
      unit: 'sat',
      min_amount: config.MIN_MELT_AMOUNT,
      max_amount: config.MAX_MELT_AMOUNT,
    })
  }

  if (config.SUPPORTS_LIGHTNING) {
    mintMethods.push({
      method: 'bolt11',
      unit: 'sat',
      min_amount: config.MIN_MINT_AMOUNT,
      max_amount: config.MAX_MINT_AMOUNT,
      options: {
        description: true,
      },
    })
    meltMethods.push({
      method: 'bolt11',
      unit: 'sat',
      min_amount: config.MIN_MELT_AMOUNT,
      max_amount: config.MAX_MELT_AMOUNT,
      options: {
        amountless: false,
      },
    })
  }

  return {
    name: config.MINT_NAME ?? 'Ducat UNIT Mint',
    pubkey: config.MINT_PUBKEY,
    version: '0.1.0',
    description: config.MINT_DESCRIPTION ?? 'Cashu ecash backed by UNIT',
    contact: [
      config.MINT_CONTACT_EMAIL && { method: 'email', info: config.MINT_CONTACT_EMAIL },
      config.MINT_CONTACT_NOSTR && { method: 'nostr', info: config.MINT_CONTACT_NOSTR },
    ].filter(Boolean),
    motd: 'Welcome to Ducat UNIT Mint!',
    nuts: {
      '4': {
        methods: mintMethods,
        disabled: false,
      },
      '5': {
        methods: meltMethods,
        disabled: false,
      },
      '7': { supported: true },
      '8': { supported: config.SUPPORTS_LIGHTNING },
      '10': { supported: true },
      '11': { supported: true },
      '12': { supported: false },
      '20': { supported: true },
      '23': { supported: config.SUPPORTS_LIGHTNING },
      '26': { supported: config.SUPPORTED_UNITS_ARRAY.includes('unit') || config.SUPPORTS_BITCOIN },
    },
  }
}
