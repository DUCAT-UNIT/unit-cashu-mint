import { config } from 'dotenv'
import { z } from 'zod'

config()

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().default('3000'),
    HOST: z.string().default('0.0.0.0'),

    // Enclave mode flag - enables enclave-specific behavior
    ENCLAVE_MODE: z
      .string()
      .transform((v) => v === 'true')
      .default('false'),

    DATABASE_URL: z.string(),
    REDIS_URL: z.string().optional(),

    NETWORK: z.enum(['mainnet', 'testnet', 'signet', 'regtest', 'mutinynet']).default('testnet'),
    ESPLORA_URL: z.string(),
    ORD_URL: z.string(),
    MEMPOOL_URL: z.string(),

    MINT_SEED: z.string().length(64), // 32 bytes hex
    MINT_PUBKEY: z.string(),
    MINT_TAPROOT_ADDRESS: z.string().optional(), // Mint's taproot address for receiving UNIT
    MINT_TAPROOT_PUBKEY: z.string().optional(), // Mint's taproot internal pubkey (32-byte x-only key)
    MINT_SEGWIT_ADDRESS: z.string().optional(), // Mint's segwit address for fees
    SUPPORTED_RUNES: z.string().optional(), // UNIT rune ID (e.g. 1527352:1) - required if 'unit' enabled

    // Multi-unit support
    SUPPORTED_UNITS: z.string().default('unit'), // Comma-separated: 'unit', 'btc', or 'unit,btc'

    // BTC Backend configuration (required if 'btc' or 'sat' in SUPPORTED_UNITS)
    MINT_BTC_ADDRESS: z.string().optional(), // P2WPKH address for BTC deposits
    MINT_BTC_PUBKEY: z.string().optional(), // Public key for BTC signing
    BTC_FEE_RATE: z.string().default('5'), // sats/vbyte

    // Optional Lightning backend for standard Cashu bolt11 compatibility
    LIGHTNING_BACKEND: z.enum(['disabled', 'lnbits', 'fake']).default('disabled'),
    LNBITS_URL: z.string().url().optional(),
    LNBITS_INVOICE_KEY: z.string().optional(),
    LNBITS_ADMIN_KEY: z.string().optional(),
    LIGHTNING_FEE_RESERVE: z.string().default('2'), // sats

    KEY_ENCRYPTION_MODE: z.enum(['local', 'gcp-kms']).default('local'),
    KMS_KEY_NAME: z.string().optional(),
    GOOGLE_OAUTH_ACCESS_TOKEN: z.string().optional(),
    ENCRYPTION_KEY: z.string().length(64).optional(),
    JWT_SECRET: z.string(),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    RATE_LIMIT_MAX: z.string().default('100'),
    RATE_LIMIT_WINDOW: z.string().default('60000'),

    MINT_NAME: z.string().default('Ducat UNIT Mint'),
    MINT_DESCRIPTION: z.string().default('Cashu ecash backed by UNIT'),
    MINT_CONTACT_EMAIL: z.string().email().optional(),
    MINT_CONTACT_NOSTR: z.string().optional(),

    CORS_ORIGINS: z.string().optional(), // Comma-separated list of allowed origins

    MIN_MINT_AMOUNT: z.string().default('100'),
    MAX_MINT_AMOUNT: z.string().default('100000000'),
    MIN_MELT_AMOUNT: z.string().default('100'),
    MAX_MELT_AMOUNT: z.string().default('100000000'),

    MINT_CONFIRMATIONS: z.string().default('1'),
    MELT_CONFIRMATIONS: z.string().default('1'),
  })
  .superRefine((value, ctx) => {
    if (value.KEY_ENCRYPTION_MODE === 'local' && !value.ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message: 'ENCRYPTION_KEY is required when KEY_ENCRYPTION_MODE=local',
      })
    }

    if (value.KEY_ENCRYPTION_MODE === 'gcp-kms' && !value.KMS_KEY_NAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KMS_KEY_NAME'],
        message: 'KMS_KEY_NAME is required when KEY_ENCRYPTION_MODE=gcp-kms',
      })
    }

    if (value.LIGHTNING_BACKEND === 'fake' && value.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LIGHTNING_BACKEND'],
        message: 'LIGHTNING_BACKEND=fake is only allowed outside production',
      })
    }
  })

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables')
}

// Parse supported units. "btc" is kept for older Ducat clients; "sat" is the
// Cashu-preferred Bitcoin minor unit that wallets expect for BTC ecash.
const configuredSupportedUnits = parsed.data.SUPPORTED_UNITS.split(',')
  .map((u) => u.trim())
  .filter(Boolean)
const supportsLightning = parsed.data.LIGHTNING_BACKEND !== 'disabled'
const supportsBitcoin =
  configuredSupportedUnits.includes('btc') || configuredSupportedUnits.includes('sat')
const supportedUnits =
  supportsBitcoin || supportsLightning
    ? Array.from(new Set([...configuredSupportedUnits, 'sat']))
    : configuredSupportedUnits

// Validate unit-specific configuration
if (supportedUnits.includes('unit') && !parsed.data.SUPPORTED_RUNES) {
  console.error('❌ SUPPORTED_RUNES is required when "unit" unit is enabled')
  throw new Error('SUPPORTED_RUNES required for unit')
}

if (supportsBitcoin && !parsed.data.MINT_BTC_ADDRESS) {
  console.error('❌ MINT_BTC_ADDRESS is required when "btc" or "sat" unit is enabled')
  throw new Error('MINT_BTC_ADDRESS required for bitcoin units')
}

if (parsed.data.LIGHTNING_BACKEND === 'lnbits') {
  if (!parsed.data.LNBITS_URL || !parsed.data.LNBITS_INVOICE_KEY || !parsed.data.LNBITS_ADMIN_KEY) {
    console.error(
      '❌ LNBITS_URL, LNBITS_INVOICE_KEY, and LNBITS_ADMIN_KEY are required when LIGHTNING_BACKEND=lnbits'
    )
    throw new Error('LNbits configuration required for lightning')
  }
}

export const env = {
  ...parsed.data,
  PORT: parseInt(parsed.data.PORT),
  RATE_LIMIT_MAX: parseInt(parsed.data.RATE_LIMIT_MAX),
  RATE_LIMIT_WINDOW: parseInt(parsed.data.RATE_LIMIT_WINDOW),
  MIN_MINT_AMOUNT: parseInt(parsed.data.MIN_MINT_AMOUNT),
  MAX_MINT_AMOUNT: parseInt(parsed.data.MAX_MINT_AMOUNT),
  MIN_MELT_AMOUNT: parseInt(parsed.data.MIN_MELT_AMOUNT),
  MAX_MELT_AMOUNT: parseInt(parsed.data.MAX_MELT_AMOUNT),
  MINT_CONFIRMATIONS: parseInt(parsed.data.MINT_CONFIRMATIONS),
  MELT_CONFIRMATIONS: parseInt(parsed.data.MELT_CONFIRMATIONS),
  BTC_FEE_RATE: parseInt(parsed.data.BTC_FEE_RATE),
  LIGHTNING_FEE_RESERVE: parseInt(parsed.data.LIGHTNING_FEE_RESERVE),
  SUPPORTED_UNITS_ARRAY: supportedUnits,
  SUPPORTS_BITCOIN: supportsBitcoin,
  SUPPORTS_LIGHTNING: supportsLightning,
  SUPPORTED_RUNES_ARRAY: parsed.data.SUPPORTED_RUNES
    ? parsed.data.SUPPORTED_RUNES.split(',').map((r) => r.trim())
    : [],
  CORS_ORIGINS_ARRAY: parsed.data.CORS_ORIGINS
    ? parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim())
    : undefined,
}

export type Env = typeof env
