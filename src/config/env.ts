import { config } from 'dotenv'
import { z } from 'zod'

config()

const envSchema = z.object({
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
  SUPPORTED_RUNES: z.string().optional(), // UNIT rune ID (840000:3) - required if 'sat' unit enabled

  // Multi-unit support
  SUPPORTED_UNITS: z.string().default('sat'), // Comma-separated: 'btc', 'sat', or 'btc,sat'

  // BTC Backend configuration (required if 'btc' in SUPPORTED_UNITS)
  MINT_BTC_ADDRESS: z.string().optional(), // P2WPKH address for BTC deposits
  MINT_BTC_PUBKEY: z.string().optional(), // Public key for BTC signing
  BTC_FEE_RATE: z.string().default('5'), // sats/vbyte

  ENCRYPTION_KEY: z.string().length(64),
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

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables')
}

// Parse supported units
const supportedUnits = parsed.data.SUPPORTED_UNITS.split(',').map((u) => u.trim())

// Validate unit-specific configuration
if (supportedUnits.includes('sat') && !parsed.data.SUPPORTED_RUNES) {
  console.error('❌ SUPPORTED_RUNES is required when "sat" unit is enabled')
  throw new Error('SUPPORTED_RUNES required for sat unit')
}

if (supportedUnits.includes('btc') && !parsed.data.MINT_BTC_ADDRESS) {
  console.error('❌ MINT_BTC_ADDRESS is required when "btc" unit is enabled')
  throw new Error('MINT_BTC_ADDRESS required for btc unit')
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
  SUPPORTED_UNITS_ARRAY: supportedUnits,
  SUPPORTED_RUNES_ARRAY: parsed.data.SUPPORTED_RUNES
    ? parsed.data.SUPPORTED_RUNES.split(',').map((r) => r.trim())
    : [],
  CORS_ORIGINS_ARRAY: parsed.data.CORS_ORIGINS
    ? parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim())
    : undefined,
}

export type Env = typeof env
