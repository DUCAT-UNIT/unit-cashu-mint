# Nitro Enclave Dockerfile for Ducat Cashu Mint
# Builds an EIF (Enclave Image File) containing:
# - Node.js 20 runtime with compiled TypeScript mint
# - Nginx for TLS termination with ACM for Nitro Enclaves
# - kmstool-enclave-cli for KMS attestation-based secret unsealing
# - vsock adapters for database/service connectivity
#
# NOTE: This image expects pre-compiled dist/ from build.sh
# The build.sh script runs `npm run build` on the host first

# =============================================================================
# Stage 1: Build kmstool-enclave-cli from aws-nitro-enclaves-sdk-c
# Matches official: https://github.com/aws/aws-nitro-enclaves-sdk-c/blob/main/containers/Dockerfile.al2
# Uses static linking (no BUILD_SHARED_LIBS) to match official approach
# =============================================================================
FROM amazonlinux:2 AS kmstool-builder

# Install build dependencies (AL2 packages)
RUN amazon-linux-extras install -y epel && \
    yum install -y \
    cmake3 \
    gcc \
    gcc-c++ \
    make \
    git \
    openssl-devel \
    curl-devel \
    golang \
    ninja-build \
    && yum clean all

# Symlink cmake3 to cmake if needed
RUN command -v cmake >/dev/null 2>&1 || ln -s /usr/bin/cmake3 /usr/bin/cmake

WORKDIR /build

# Clone and build aws-lc (v1.12.0)
RUN git clone --depth 1 -b v1.12.0 https://github.com/awslabs/aws-lc.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 -DCMAKE_BUILD_TYPE=Release \
        -GNinja -S aws-lc -B aws-lc/build && \
    cmake3 --build aws-lc/build --parallel $(nproc) --target install

# Clone and build s2n-tls (v1.3.46)
RUN git clone --depth 1 -b v1.3.46 https://github.com/aws/s2n-tls.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S s2n-tls -B s2n-tls/build && \
    cmake3 --build s2n-tls/build --parallel $(nproc) --target install

# Clone and build aws-c-common (v0.8.0)
RUN git clone --depth 1 -b v0.8.0 https://github.com/awslabs/aws-c-common.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S aws-c-common -B aws-c-common/build && \
    cmake3 --build aws-c-common/build --parallel $(nproc) --target install

# Clone and build aws-c-sdkutils (v0.1.2)
RUN git clone --depth 1 -b v0.1.2 https://github.com/awslabs/aws-c-sdkutils.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S aws-c-sdkutils -B aws-c-sdkutils/build && \
    cmake3 --build aws-c-sdkutils/build --parallel $(nproc) --target install

# Clone and build aws-c-cal (v0.5.18)
RUN git clone --depth 1 -b v0.5.18 https://github.com/awslabs/aws-c-cal.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S aws-c-cal -B aws-c-cal/build && \
    cmake3 --build aws-c-cal/build --parallel $(nproc) --target install

# Clone and build aws-c-io (v0.11.0) with vsock support
RUN git clone --depth 1 -b v0.11.0 https://github.com/awslabs/aws-c-io.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 -DUSE_VSOCK=1 \
        -GNinja -S aws-c-io -B aws-c-io/build && \
    cmake3 --build aws-c-io/build --parallel $(nproc) --target install

# Clone and build aws-c-compression (v0.2.14)
RUN git clone --depth 1 -b v0.2.14 https://github.com/awslabs/aws-c-compression.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S aws-c-compression -B aws-c-compression/build && \
    cmake3 --build aws-c-compression/build --parallel $(nproc) --target install

# Clone and build aws-c-http (v0.7.6)
RUN git clone --depth 1 -b v0.7.6 https://github.com/awslabs/aws-c-http.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S aws-c-http -B aws-c-http/build && \
    cmake3 --build aws-c-http/build --parallel $(nproc) --target install

# Clone and build aws-c-auth (v0.6.15)
RUN git clone --depth 1 -b v0.6.15 https://github.com/awslabs/aws-c-auth.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_TESTING=0 \
        -GNinja -S aws-c-auth -B aws-c-auth/build && \
    cmake3 --build aws-c-auth/build --parallel $(nproc) --target install

# Build json-c as static library (matches official)
RUN git clone --depth 1 -b json-c-0.16-20220414 https://github.com/json-c/json-c.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=0 \
        -GNinja -S json-c -B json-c/build && \
    cmake3 --build json-c/build --parallel $(nproc) --target install

# Install Rust for NSM API
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Clone and build aws-nitro-enclaves-nsm-api (v0.4.0)
RUN git clone --depth 1 -b v0.4.0 https://github.com/aws/aws-nitro-enclaves-nsm-api.git && \
    cd aws-nitro-enclaves-nsm-api && \
    cargo build --release --jobs $(nproc) -p nsm-lib && \
    cp target/release/libnsm.so /usr/lib64/ && \
    cp target/release/libnsm.a /usr/lib64/ && \
    cp target/release/nsm.h /usr/include/

# Clone and build aws-nitro-enclaves-sdk-c with kmstool
RUN git clone --depth 1 -b v0.4.2 https://github.com/aws/aws-nitro-enclaves-sdk-c.git && \
    cmake3 -DCMAKE_PREFIX_PATH=/usr -DCMAKE_INSTALL_PREFIX=/usr \
        -GNinja -S aws-nitro-enclaves-sdk-c -B aws-nitro-enclaves-sdk-c/build && \
    cmake3 --build aws-nitro-enclaves-sdk-c/build --parallel $(nproc) --target install

# Verify kmstool-enclave-cli was built
RUN ls -la /usr/bin/kmstool* 2>/dev/null && echo "kmstool found" || \
    (find /build -name "kmstool*" -type f 2>/dev/null && echo "kmstool found in build dir")

# =============================================================================
# Stage 2: Final enclave image
# =============================================================================
FROM amazonlinux:2023

# Install runtime dependencies including Nginx
# Note: Using --allowerasing to handle libcurl conflicts
RUN dnf install -y --allowerasing \
    nodejs20 \
    npm \
    jq \
    openssl \
    openssl-libs \
    ca-certificates \
    socat \
    procps-ng \
    iproute \
    nginx \
    json-c \
    libcurl \
    && dnf clean all

# Create directories
RUN mkdir -p /run/acm /var/log/nginx /var/lib/nginx /run/secrets

# Copy KMS tool binary and required shared libraries from builder
# kmstool is statically linked against AWS libs but needs libnsm.so at runtime
COPY --from=kmstool-builder /usr/bin/kmstool_enclave_cli /usr/bin/kmstool-enclave-cli
COPY --from=kmstool-builder /usr/lib64/libnsm.so /usr/lib64/

# Update library cache
RUN ldconfig

WORKDIR /app

# Copy package files first (for layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy pre-compiled dist from host (built by build.sh)
COPY dist/ ./dist/

# Copy enclave-specific scripts
COPY enclave/entrypoint.sh /app/entrypoint.sh
COPY enclave/unseal-secrets.sh /app/unseal-secrets.sh
COPY enclave/vsock-adapter.sh /app/vsock-adapter.sh

# Copy Nginx config for TLS termination
COPY enclave/nginx.conf /etc/nginx/nginx.conf

# Make scripts executable
RUN chmod +x /app/entrypoint.sh /app/unseal-secrets.sh /app/vsock-adapter.sh

# KMS configuration - ARG allows build-time customization
# These become ENV vars that the entrypoint can read
ARG KMS_KEY_ID=""
ARG AWS_REGION="us-east-1"
ARG FIRST_BOOT="false"

ENV KMS_KEY_ID=${KMS_KEY_ID}
ENV AWS_REGION=${AWS_REGION}
ENV FIRST_BOOT=${FIRST_BOOT}

# Run as root inside enclave (needed for vsock and port binding)
# Security is handled by the enclave isolation itself

ENTRYPOINT ["/app/entrypoint.sh"]
