# Ducat Runes Mint

A Cashu ecash mint backed by Bitcoin Runes tokens, specifically designed to work with the Ducat Protocol.

## Overview

This mint server implements the Cashu protocol (NUT specifications) to provide fast, private ecash tokens backed by Bitcoin Runes. Users can deposit DUCAT•UNIT•RUNE (or other supported Runes) and receive Cashu ecash tokens that can be transferred instantly and privately, then redeemed back to Runes on-chain.

## Features

- **Cashu Protocol Compatible**: Works with existing Cashu wallets (eNuts, Minibits, Nutstash)
- **Runes Backed**: Ecash tokens are 1:1 backed by Bitcoin Runes UTXOs
- **Privacy Preserving**: Blind signatures ensure the mint cannot link deposits to withdrawals
- **Fast Transfers**: Send ecash tokens instantly without on-chain transactions
- **Multi-Rune Support**: Support for multiple Runes tokens with separate keysets
- **Federation Ready**: Designed to work with Ducat's existing 4-guardian infrastructure

## Architecture

```
┌─────────────┐
│   Client    │
│  (Wallet)   │
└──────┬──────┘
       │
       ├─── Deposit Runes ─────┐
       │                       ▼
       │                 ┌──────────────┐
       │                 │  Mint Server │
       │                 │  (Cashu API) │
       │                 └──────┬───────┘
       │                        │
       │                        ├─── Blind Sign Tokens
       │                        │
       │◄─── Ecash Tokens ──────┤
       │                        │
       │                        ├─── Monitor Blockchain
       │                        │
       │                        ▼
       │                 ┌──────────────┐
       │                 │   Bitcoin    │
       ├─── Redeem ─────►│  (Runes)     │
       │                 └──────────────┘
       └─────────────────►
```

## Implementation Phases

### Phase 1: Core Mint Infrastructure (Weeks 1-2)
- [x] Project setup
- [ ] Cryptography layer (key generation, blind signatures)
- [ ] Database schema
- [ ] Core Cashu endpoints (NUT-00 to NUT-06)
  - [ ] `/v1/info` - Mint information
  - [ ] `/v1/keys` - Public key distribution
  - [ ] `/v1/mint/quote/*` - Deposit quotes
  - [ ] `/v1/mint/*` - Issue tokens
  - [ ] `/v1/swap` - Exchange tokens
  - [ ] `/v1/melt/quote/*` - Withdrawal quotes
  - [ ] `/v1/melt/*` - Redeem tokens

### Phase 2: Runes Integration (Weeks 3-4)
- [ ] Runes deposit monitoring
- [ ] Runes withdrawal processing
- [ ] UTXO management
- [ ] Fee estimation

### Phase 3: Client Integration (Weeks 5-6)
- [ ] Mint client library
- [ ] Mobile app integration
- [ ] Web app integration
- [ ] Wallet connector updates

### Phase 4: Production Hardening (Weeks 7-8)
- [ ] Multi-keyset support
- [ ] Security hardening (key encryption, HSM)
- [ ] Operational tooling (monitoring, alerts)
- [ ] User experience features (NUT-07, NUT-08, NUT-09)

### Phase 5: Federation (Optional, Weeks 9-10)
- [ ] Multi-signature scheme
- [ ] Guardian coordination
- [ ] Reserve distribution
- [ ] Federation API

### Phase 6: Interoperability (Weeks 11-12)
- [ ] Cashu wallet testing
- [ ] Lightning bridge (optional)
- [ ] Inter-mint swaps
- [ ] Documentation

## Technology Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Fastify
- **Database**: PostgreSQL
- **Cache**: Redis
- **Blockchain**: Esplora + Ord indexer
- **Crypto**: @bitcoinerlab/secp256k1, bitcoinjs-lib

## Cashu Protocol Compliance

This mint implements the following NUTs (Notation, Usage, and Terminology):

- **NUT-00**: Core protocol (mint, swap, melt operations)
- **NUT-01**: Keyset management
- **NUT-02**: Keyset ID derivation
- **NUT-03**: Request/response formats
- **NUT-04**: Mint information endpoint
- **NUT-05**: Melting tokens (redemption)
- **NUT-06**: Mint quote/payment flow
- **NUT-07**: Token state checking (planned)
- **NUT-08**: Fee return optimization (planned)
- **NUT-09**: Token restore/backup (planned)

### Custom Extensions

- **Runes Deposits**: Custom mint method for Bitcoin Runes
- **Runes Withdrawals**: Custom melt method returning Runes UTXOs
- **Multi-Rune Keysets**: Support for multiple Runes tokens

## API Endpoints

### Standard Cashu Endpoints

```
GET  /v1/info                      - Mint information
GET  /v1/keys                      - All active keysets
GET  /v1/keys/:keyset_id           - Specific keyset
POST /v1/swap                      - Swap tokens
```

### Runes-Specific Endpoints

```
POST /v1/mint/quote/runes          - Request deposit quote
GET  /v1/mint/quote/runes/:quote   - Check quote status
POST /v1/mint/runes                - Mint tokens after deposit
POST /v1/melt/quote/runes          - Request withdrawal quote
GET  /v1/melt/quote/runes/:quote   - Check quote status
POST /v1/melt/runes                - Redeem tokens for Runes
```

## Database Schema

### Core Tables

- **keysets**: Keyset metadata and configuration
- **keyset_keys**: Private/public keys for each denomination
- **mint_quotes**: Pending deposit requests
- **melt_quotes**: Pending withdrawal requests
- **spent_proofs**: Track spent tokens (prevent double-spend)
- **mint_utxos**: Mint's Runes UTXO set

## Security Considerations

### Private Key Management
- Keys encrypted at rest
- Optional HSM integration for production
- Key rotation every 3-6 months

### Double-Spend Prevention
- Database constraints on spent proofs
- Atomic operations for token swaps
- Real-time monitoring for suspicious patterns

### Reserve Management
- Real-time balance monitoring
- Transparency reports (provable reserves)
- Circuit breakers for low reserve scenarios

### Rate Limiting
- Per-IP rate limits on all endpoints
- Quota-based limits for minting/melting
- DDoS protection

## Deployment

### Requirements

- Node.js 20+
- PostgreSQL 14+
- Redis 7+
- Bitcoin node with Esplora + Ord indexer access

### Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/mint

# Redis
REDIS_URL=redis://localhost:6379

# Bitcoin/Runes
NETWORK=testnet  # or mainnet, signet
ESPLORA_URL=https://mutinynet.com/api
ORD_URL=https://ord-mutinynet.ducatprotocol.com
MEMPOOL_URL=https://mutinynet.com/api

# Mint Configuration
MINT_SEED=<secret-seed-for-key-generation>
MINT_PUBKEY=<mint-public-key>
SUPPORTED_RUNES=840000:3  # DUCAT•UNIT•RUNE

# Security
JWT_SECRET=<secret>
ENCRYPTION_KEY=<aes-256-key>
```

### Running Locally

```bash
# Install dependencies
npm install

# Run migrations
npm run migrate

# Start development server
npm run dev

# Run tests
npm test
```

### Production Deployment

```bash
# Build
npm run build

# Start production server
npm start
```

## Integration with Ducat Protocol

This mint is designed to integrate seamlessly with the existing Ducat ecosystem:

- **Client SDK**: Reuses Ducat's `@ducat-unit/client-sdk` for transaction construction
- **Guardian Servers**: Can optionally use Ducat's 4 guardians for federated operation
- **Runes Support**: Built-in support for DUCAT•UNIT•RUNE token
- **Wallet Apps**: Integrates with existing Ducat mobile and web wallets

## Interoperability

### Works With
- Any Cashu-compatible wallet (eNuts, Minibits, Nutstash)
- Other Runes-backed Cashu mints
- Standard Cashu mints (via atomic swaps)

### Token Format
Standard Cashu token format (compatible with existing wallets):

```json
{
  "token": [{
    "mint": "https://mint.ducatprotocol.com",
    "proofs": [
      {
        "amount": 8,
        "secret": "a1b2c3...",
        "C": "02a1b2c3...",
        "id": "00ffd48b8f5e"
      }
    ]
  }]
}
```

## Monitoring & Operations

### Health Checks
- `/health` - Server health
- `/health/db` - Database connectivity
- `/health/blockchain` - Blockchain indexer status
- `/health/reserves` - Reserve balance vs issued tokens

### Metrics (Prometheus)
- Token issuance rate
- Redemption rate
- Reserve balance
- API latency
- Error rates

### Alerts
- Low reserves (<10% buffer)
- High error rates
- Blockchain sync issues
- Database performance degradation

## Development Roadmap

**Q1 2025**: Phase 1-2 (Core mint + Runes integration)
**Q2 2025**: Phase 3-4 (Client integration + Production hardening)
**Q3 2025**: Phase 5-6 (Federation + Interoperability)

## Resources

- [Cashu Protocol](https://github.com/cashubtc/nuts)
- [NUT Specifications](https://github.com/cashubtc/nuts/blob/main/00.md)
- [Ducat Protocol](https://ducatprotocol.com)
- [Bitcoin Runes](https://docs.ordinals.com/runes.html)

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

- GitHub Issues: [ducat-protocol/mint-server](https://github.com/ducat-protocol/mint-server)
- Email: support@ducatprotocol.com
- Nostr: [mint pubkey]

## Disclaimer

This is custodial software. Users trust the mint operator with their funds. Use at your own risk. This is experimental software and should not be used with significant amounts until thoroughly audited.
