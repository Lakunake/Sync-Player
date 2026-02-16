#!/bin/bash
# =============================================================================
# Sync-Player HTTPS Certificate Generator (Linux/Mac)
# =============================================================================
# Generates a self-signed SSL certificate for enabling HTTPS
# Also updates config.env to enable HTTPS and JASSUB
#
# Usage: chmod +x generate-ssl.sh && ./generate-ssl.sh
# =============================================================================

set -e

echo ""
echo "========================================"
echo " Sync-Player HTTPS Setup"
echo "========================================"
echo ""

# Get script directory (this script is in cert/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Output to current directory (cert/)
KEY_FILE="$SCRIPT_DIR/key.pem"
CERT_FILE="$SCRIPT_DIR/cert.pem"
CONFIG_FILE="$SCRIPT_DIR/../config.env"

# Check if certificates already exist
if [ -f "$KEY_FILE" ] && [ -f "$CERT_FILE" ]; then
    echo "Existing certificates found:"
    echo "  - $KEY_FILE"
    echo "  - $CERT_FILE"
    echo ""
    read -p "Regenerate certificates? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing certificates."
        echo ""
        # Skip to config update
        UPDATE_CONFIG_ONLY=true
    fi
fi

if [ -z "$UPDATE_CONFIG_ONLY" ]; then
    # Check for OpenSSL
    if ! command -v openssl &> /dev/null; then
        echo "OpenSSL not found!"
        echo ""
        echo "Please install OpenSSL:"
        echo "  macOS: brew install openssl"
        echo "  Ubuntu/Debian: sudo apt install openssl"
        echo "  CentOS/RHEL: sudo yum install openssl"
        echo ""
        exit 1
    fi

    echo "Using OpenSSL: $(which openssl)"
    echo ""

    # Get local IP for certificate
    if command -v ip &> /dev/null; then
        LOCAL_IP=$(ip route get 1 | awk '{print $7;exit}')
    elif command -v ifconfig &> /dev/null; then
        LOCAL_IP=$(ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1' | head -n1)
    else
        LOCAL_IP="192.168.1.1"
    fi

    echo "Generating self-signed certificate..."
    echo "  Valid for: localhost, $LOCAL_IP"
    echo ""

    # Create OpenSSL config for SAN
    OPENSSL_CONFIG=$(mktemp)
    cat > "$OPENSSL_CONFIG" << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = US
ST = State
L = City
O = Sync-Player
OU = Development
CN = localhost

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = $LOCAL_IP
EOF

    # Generate certificate
    openssl req -x509 -newkey rsa:2048 \
        -keyout "$KEY_FILE" \
        -out "$CERT_FILE" \
        -days 365 \
        -nodes \
        -config "$OPENSSL_CONFIG"

    rm -f "$OPENSSL_CONFIG"

    echo ""
    echo "Certificate generated successfully!"
    echo "  - Private Key: $KEY_FILE"
    echo "  - Certificate: $CERT_FILE"
    echo "  - Valid for: 365 days"
    echo ""
fi

# Update config.env
echo "Updating config.env..."

if [ -f "$CONFIG_FILE" ]; then
    # Enable HTTPS
    sed -i.bak 's/SYNC_USE_HTTPS=false/SYNC_USE_HTTPS=true/' "$CONFIG_FILE"
    
    # Set JASSUB renderer
    sed -i.bak 's/SYNC_SUBTITLE_RENDERER=wsr/SYNC_SUBTITLE_RENDERER=jassub/' "$CONFIG_FILE"
    
    # Remove backup files
    rm -f "$CONFIG_FILE.bak"
    
    echo "  - SYNC_USE_HTTPS=true"
    echo "  - SYNC_SUBTITLE_RENDERER=jassub"
    echo ""
else
    echo "  config.env not found, skipping config update"
    echo ""
fi

echo "========================================"
echo " Setup Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Restart Sync-Player"
echo "  2. Access via https://$LOCAL_IP:3000"
echo "  3. Accept the certificate warning in your browser"
echo ""
echo "Note: Clients will see a browser warning because this is a"
echo "self-signed certificate. This is normal for LAN use."
echo "Click 'Advanced' > 'Proceed to site' to continue."
echo ""
