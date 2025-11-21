# Cashu Runes Mint

A production-ready [Cashu](https://github.com/cashubtc/nuts) ecash mint backed by Bitcoin Runes.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- **Cashu Protocol**: Full NUT-00 through NUT-11 implementation
- **Bitcoin Runes Backend**: First Cashu mint using Runes as backing asset
- **Privacy-Preserving**: Blind signatures ensure unlinkability
- **P2PK Support**: Public key locks, timelocks, multisig (NUT-11)
- **Production-Ready**: Battle-tested with real transactions

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Bitcoin node with Esplora API and Ord indexer

### Installation

```bash
# Clone and install
git clone https://github.com/DUCAT-UNIT/cashu-mint.git
cd cashu-mint
npm install

# Configure environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
npm run migrate

# Start server
npm run dev
```

### Configuration

Required environment variables in `.env`:

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/cashu_mint

# Bitcoin Network
NETWORK=mutinynet
ESPLORA_URL=https://mutinynet.com/api
ORD_URL=https://ord-mutinynet.ducatprotocol.com

# Mint Security (GENERATE SECURE RANDOM VALUES!)
MINT_SEED=<64 hex chars>        # openssl rand -hex 32
ENCRYPTION_KEY=<64 hex chars>   # openssl rand -hex 32

# Runes Configuration
SUPPORTED_RUNES=1527352:1  # DUCAT•UNIT•RUNE on mutinynet
```

## API Endpoints

### Mint Operations

```http
POST   /v1/mint/quote/unit       # Create deposit quote
GET    /v1/mint/quote/unit/:id   # Check quote status
POST   /v1/mint/unit             # Mint tokens from paid quote

POST   /v1/melt/quote/unit       # Create withdrawal quote
GET    /v1/melt/quote/unit/:id   # Check quote status
POST   /v1/melt/unit             # Withdraw to Runes

POST   /v1/swap                  # Swap tokens
POST   /v1/checkstate            # Check proof states
GET    /v1/keys                  # Get active keysets
GET    /v1/info                  # Get mint info
```

See [API documentation](docs/API.md) for detailed request/response formats.

## NUT Compliance

| NUT | Specification | Status |
|-----|---------------|--------|
| 00 | Cryptography & Models | ✅ |
| 01 | Mint Keys | ✅ |
| 02 | Keysets | ✅ |
| 03 | Swap | ✅ |
| 04 | Mint Tokens | ✅ |
| 05 | Melt Tokens | ✅ |
| 06 | Mint Info | ✅ |
| 07 | Token State | ✅ |
| 10 | Spending Conditions | ✅ |
| 11 | P2PK | ✅ (SIG_INPUTS only) |

## Architecture

```
┌─────────────┐
│   Wallet    │ (eNuts, Minibits, etc.)
└──────┬──────┘
       │
       ├─── POST /v1/mint/quote/unit  (deposit)
       ├─── POST /v1/swap             (exchange)
       └─── POST /v1/melt/quote/unit  (withdraw)
       │
┌──────▼──────────────────────┐
│   Cashu Mint (Fastify)      │
│  ┌──────────────────────┐   │
│  │ BDHKE Blind Sigs     │   │
│  │ P2PK Verification    │   │
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ Runes Integration    │   │
│  │ UTXO Management      │   │
│  │ PSBT Building        │   │
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ PostgreSQL Database  │   │
│  └──────────────────────┘   │
└─────────┬───────────────────┘
          │
┌─────────▼───────────┐
│ Bitcoin (Mutinynet) │
│ Esplora + Ord       │
└─────────────────────┘
```

## Development

```bash
# Run tests
npm test

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Build for production
npm run build

# Run production server
npm start
```

## Security

⚠️ **This is custodial software.** Users must trust the mint operator.

### Best Practices

- **Generate secure seeds**: Use `openssl rand -hex 32` for `MINT_SEED` and `ENCRYPTION_KEY`
- **Use HTTPS**: Run behind reverse proxy (nginx, Caddy) with TLS
- **Restrict CORS**: Set `CORS_ORIGINS` to allowed origins only
- **Monitor reserves**: Ensure issued tokens ≤ UTXO balance
- **Backup database**: Regular PostgreSQL backups critical for key recovery

### Known Limitations

- Custodial (mint can freeze/steal funds)
- No DLEQ proofs (NUT-12) - timing analysis possible
- Single point of failure (not federated)
- Keys encrypted in software (no HSM support)

**Report security issues to**: security@ducatprotocol.com

## Project Structure

```
cashu-mint/
├── src/
│   ├── api/routes/          # HTTP endpoints
│   ├── core/
│   │   ├── crypto/          # BDHKE, signatures, keys
│   │   ├── services/        # Business logic
│   │   └── models/          # Data models
│   ├── runes/               # Runes integration
│   ├── database/            # Repositories
│   └── utils/               # Errors, logging
├── tests/                   # Unit & integration tests
├── migrations/              # Database migrations
└── docs/                    # Additional documentation
```

## License

MIT License - see [LICENSE](LICENSE) file.

## Disclaimer

⚠️ **Experimental software.** Use at your own risk with small amounts only.

⚠️ **No warranty.** Provided "as is" without any guarantees.

For production deployment, conduct a professional security audit.

---

**Built for the Bitcoin & Cashu ecosystem**

[Report Issues](https://github.com/DUCAT-UNIT/cashu-mint/issues) • [Documentation](docs/)
