# Nitro Enclave Dockerfile for Ducat Cashu Mint
# Builds an EIF (Enclave Image File) containing:
# - Node.js 20 runtime with compiled TypeScript mint
# - Nginx for TLS termination with ACM PKCS#11
# - AWS Nitro Enclaves SDK for attestation
# - vsock adapters for database/service connectivity

FROM amazonlinux:2023 AS builder

# Install build dependencies
RUN dnf install -y \
    nodejs20 \
    npm \
    gcc \
    gcc-c++ \
    make \
    cmake \
    git \
    && dnf clean all

WORKDIR /build

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM amazonlinux:2023

# Install runtime dependencies
RUN dnf install -y \
    nodejs20 \
    nginx \
    aws-nitro-enclaves-acm \
    aws-nitro-enclaves-cli \
    jq \
    openssl \
    ca-certificates \
    socat \
    && dnf clean all

# Create app user
RUN useradd -r -s /bin/false mintuser

WORKDIR /app

# Copy compiled application from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy enclave-specific configuration
COPY enclave/nginx.conf /etc/nginx/nginx.conf
COPY enclave/entrypoint.sh /app/entrypoint.sh
COPY enclave/unseal-secrets.sh /app/unseal-secrets.sh
COPY enclave/vsock-adapter.sh /app/vsock-adapter.sh
COPY enclave/.env.template /app/.env.template

# Make scripts executable
RUN chmod +x /app/entrypoint.sh /app/unseal-secrets.sh /app/vsock-adapter.sh

# Create directories for ACM certificates and logs
RUN mkdir -p /run/acm /var/log/nginx /var/lib/nginx

# Set ownership
RUN chown -R mintuser:mintuser /app /var/log/nginx

# Expose vsock port for incoming TLS connections
# Port 8443 receives TLS traffic from parent's TCP passthrough
# The enclave has no network interface - all traffic via vsock
EXPOSE 8443

# Health check (inside enclave, checks Node.js server)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:3338/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
