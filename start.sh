#!/bin/bash
# Sync-Player Bash Startup Script
# Linux/Mac equivalent of console.ps1

# =================================================================
# Retry Counter (resets on computer reboot via /tmp folder)
# =================================================================
RETRY_FILE="/tmp/sync_player_retry_count.txt"
MAX_RETRIES=2
RETRY_COUNT=0

if [ -f "$RETRY_FILE" ]; then
    RETRY_COUNT=$(cat "$RETRY_FILE")
fi

# =================================================================
# Get script location and set working directory
# Script runs from root, server.js is in res/
# =================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "Running from: $PWD"

# =================================================================
# Helper function for colored output
# =================================================================
write_status() {
    local type="$1"
    local message="$2"
    
    case "$type" in
        "OK")       echo -e "\033[36m[OK]: $message\033[0m" ;;
        "MISSING")  echo -e "\033[33m[MISSING]: $message\033[0m" ;;
        "WARNING")  echo -e "\033[33m[WARNING]: $message\033[0m" ;;
        "ERROR")    echo -e "\033[31m[ERROR]: $message\033[0m" ;;
        "CRITICAL") echo -e "\033[31m[CRITICAL]: $message\033[0m" ;;
        "INFO")     echo -e "\033[36m[INFO]: $message\033[0m" ;;
        "SUCCESS")  echo -e "\033[32m[SUCCESS]: $message\033[0m" ;;
        "REQUIRED") echo -e "\033[33m[REQUIRED]: $message\033[0m" ;;
        "DEBUG")    echo -e "\033[90m[DEBUG]: $message\033[0m" ;;
        *)          echo "$message" ;;
    esac
}

# =================================================================
# Check Node.js installation
# =================================================================
echo "Checking Node.js installation..."

if ! command -v node &> /dev/null; then
    echo ""
    write_status "ERROR" "Node.js is not installed or not in PATH!"
    echo "Please download and install Node.js from:"
    echo -e "\033[36mhttps://nodejs.org/\033[0m"
    echo ""
    
    # Detect OS and suggest installation method
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "On macOS, you can install via Homebrew:"
        echo "  brew install node"
    else
        echo "On Linux, you can install via your package manager:"
        echo "  Ubuntu/Debian: sudo apt install nodejs npm"
        echo "  Fedora: sudo dnf install nodejs npm"
        echo "  Arch: sudo pacman -S nodejs npm"
    fi
    
    echo ""
    read -p "Press Enter to continue after installing Node.js, or Ctrl+C to exit..."
fi

# =================================================================
# Initialize configuration (in root directory)
# =================================================================
if [ ! -f "config.env" ]; then
    echo "Creating default configuration..."
    
    cat > config.env << 'EOF'
# Sync-Player Configuration
# Lines starting with # are comments

# Server port (1024-49151)
port: 3000

# Volume step percentage (1-20)
volume_step: 5

# Skip seconds (1-60)
skip_seconds: 5

# Join mode: sync or reset
join_mode: sync

# HTTPS Configuration
use_https: false
ssl_key_file: key.pem
ssl_cert_file: cert.pem

# BSL-S2 (Both Side Local Sync Stream) Configuration
# Mode: 'any' = BSL-S2 active if ANY client has the local file
#       'all' = BSL-S2 only active if ALL clients have the local file
bsl_s2_mode: any

# Video Autoplay Configuration
# Set to true to automatically play videos when loaded
# Set to false to start videos paused
video_autoplay: false

# Admin Fingerprint Lock
# When enabled, only the first machine to access /admin will be allowed
# The fingerprint is stored in memory/memory.json
# Set to true to enable, false to allow any machine to access admin
admin_fingerprint_lock: false

# BSL-S² Advanced Matching
# When enabled, matches files using multiple criteria (name, size, extension, MIME)
bsl_advanced_match: true

# BSL-S² Advanced Match Threshold (1-4)
bsl_advanced_match_threshold: 1

# Skip Intro Seconds
# How many seconds the "Skip Intro" button jumps forward
skip_intro_seconds: 87

# Client Controls Configuration
client_controls_disabled: false

# Client Sync to Server Configuration
client_sync_disabled: false

# Server Mode
server_mode: false

# Chat Feature
chat_enabled: true

# Data Hydration Optimization
data_hydration: true
EOF
    
    echo "Default config created with all available options"
fi

# =================================================================
# Create folders if needed (in root directory)
# =================================================================
if [ ! -d "media" ]; then
    mkdir -p media
    echo "Created media directory"
fi
if [ ! -d "res/tracks" ]; then
    mkdir -p res/tracks
    echo "Created res/tracks directory"
fi
if [ ! -d "memory/tracks" ]; then
    mkdir -p memory/tracks
    echo "Created memory/tracks directory"
fi
if [ ! -d "cert" ]; then
    mkdir -p cert
    echo "Created cert directory"
fi

# =================================================================
# Check and Install Dependencies (in res/ directory)
# =================================================================
echo "Checking required dependencies..."

MISSING_DEPS=false
REQUIRED_PACKAGES=("express" "socket.io" "helmet" "express-rate-limit" "rate-limiter-flexible" "cookie-parser" "node-av" "fast-deep-equal")

if [ ! -d "res/node_modules" ]; then
    MISSING_DEPS=true
    write_status "MISSING" "Node.js dependencies (express, socket.io, helmet)"
else
    echo "Checking for specific dependencies..."
    for pkg in "${REQUIRED_PACKAGES[@]}"; do
        if [ ! -d "res/node_modules/$pkg" ]; then
            MISSING_DEPS=true
            write_status "MISSING" "$pkg package"
        fi
    done
    if [ "$MISSING_DEPS" = false ]; then
        write_status "OK" "All Node.js dependencies found"
    fi
fi

# Check FFmpeg (Skip if node-av is installed)
MISSING_FFMPEG=false
if [ -d "res/node_modules/node-av" ]; then
    write_status "OK" "FFmpeg bundled with node-av"
else
    if ! command -v ffmpeg &> /dev/null; then
        MISSING_FFMPEG=true
        write_status "MISSING" "FFmpeg (required for video processing)"
    else
        write_status "OK" "FFmpeg found"
    fi
fi

# Install missing Node.js dependencies (run npm from res/ directory)
if [ "$MISSING_DEPS" = true ]; then
    echo ""
    write_status "REQUIRED" "This software needs Node.js dependencies to work properly."
    echo "Missing packages: express, socket.io, helmet"
    echo ""
    read -p "Press ENTER to install dependencies automatically, or Ctrl+C to exit..."
    echo ""
    echo "Installing Node.js dependencies..."
    
    pushd "res" > /dev/null
    if npm install; then
        popd > /dev/null
        write_status "SUCCESS" "Dependencies installed successfully."
        MISSING_DEPS=false
        [ -f "$RETRY_FILE" ] && rm -f "$RETRY_FILE"
    else
        popd > /dev/null
        write_status "ERROR" "Failed to install dependencies."
        echo "Please check your internet connection and try again."
        echo "You can also try running: cd res && npm install"
        echo ""
        
        # Auto-retry logic
        if [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; then
            RETRY_COUNT=$((RETRY_COUNT + 1))
            echo "$RETRY_COUNT" > "$RETRY_FILE"
            echo "Retry attempt $RETRY_COUNT of $MAX_RETRIES..."
            echo "Restarting in 3 seconds..."
            sleep 3
            exec "$0"
            exit 0
        else
            write_status "CRITICAL" "Maximum retry attempts reached."
            echo "Please fix the issue manually and restart the script."
            [ -f "$RETRY_FILE" ] && rm -f "$RETRY_FILE"
            read -p "Press Enter to exit..."
            exit 1
        fi
    fi
fi

# Install FFmpeg if missing
if [ "$MISSING_FFMPEG" = true ]; then
    echo ""
    write_status "REQUIRED" "FFmpeg is not installed."
    echo "FFmpeg is required for proper video processing and MKV support."
    echo ""
    
    # Detect OS and suggest installation method
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "On macOS, install via Homebrew:"
        echo "  brew install ffmpeg"
    else
        echo "On Linux, install via your package manager:"
        echo "  Ubuntu/Debian: sudo apt install ffmpeg"
        echo "  Fedora: sudo dnf install ffmpeg"
        echo "  Arch: sudo pacman -S ffmpeg"
    fi
    
    echo ""
    read -p "Press Enter to continue (FFmpeg installation is recommended but optional)..."
fi

# =================================================================
# Read configuration (from root directory)
# =================================================================
# Default values
PORT=3000
VOLUME_STEP=5
SKIP_SECONDS=5
JOIN_MODE="sync"
USE_HTTPS="false"
BSL_S2_MODE="any"
ADMIN_LOCK="false"

if [ -f "config.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        
        # Parse key: value pairs (legacy format) or KEY=value (env format)
        if [[ "$line" =~ ^[[:space:]]*([a-zA-Z_]+)[[:space:]]*:[[:space:]]*(.+)[[:space:]]*$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            value="${value%"${value##*[![:space:]]}"}"  # Trim trailing whitespace
            
            case "$key" in
                "port")                   PORT="$value" ;;
                "volume_step")            VOLUME_STEP="$value" ;;
                "skip_seconds")           SKIP_SECONDS="$value" ;;
                "join_mode")              JOIN_MODE="$value" ;;
                "use_https")              USE_HTTPS="$value" ;;
                "bsl_s2_mode")            BSL_S2_MODE="$value" ;;
                "admin_fingerprint_lock") ADMIN_LOCK="$value" ;;
                "bsl_advanced_match")     BSL_ADV_MATCH="$value" ;;
                "bsl_advanced_match_threshold") BSL_ADV_MATCH_THRESHOLD="$value" ;;
                "skip_intro_seconds")     SKIP_INTRO_SECONDS="$value" ;;
                "client_controls_disabled") CLIENT_CONTROLS_DISABLED="$value" ;;
                "client_sync_disabled")   CLIENT_SYNC_DISABLED="$value" ;;
                "server_mode")            SERVER_MODE="$value" ;;
                "chat_enabled")           CHAT_ENABLED="$value" ;;
                "data_hydration")         DATA_HYDRATION="$value" ;;
                "show_ssl_tip")           SHOW_SSL_TIP="$value" ;;
            esac
        fi
    done < config.env
# Migrate from legacy config.txt if it exists
elif [ -f "config.txt" ]; then
    write_status "WARNING" "Migrating from legacy config.txt..."
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        
        if [[ "$line" =~ ^[[:space:]]*([a-zA-Z_]+)[[:space:]]*:[[:space:]]*(.+)[[:space:]]*$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            value="${value%"${value##*[![:space:]]}"}"  # Trim trailing whitespace
            
            case "$key" in
                "port")                   PORT="$value" ;;
                "volume_step")            VOLUME_STEP="$value" ;;
                "skip_seconds")           SKIP_SECONDS="$value" ;;
                "join_mode")              JOIN_MODE="$value" ;;
                "use_https")              USE_HTTPS="$value" ;;
                "bsl_s2_mode")            BSL_S2_MODE="$value" ;;
                "admin_fingerprint_lock") ADMIN_LOCK="$value" ;;
                "bsl_advanced_match")     BSL_ADV_MATCH="$value" ;;
                "bsl_advanced_match_threshold") BSL_ADV_MATCH_THRESHOLD="$value" ;;
                "skip_intro_seconds")     SKIP_INTRO_SECONDS="$value" ;;
                "client_controls_disabled") CLIENT_CONTROLS_DISABLED="$value" ;;
                "client_sync_disabled")   CLIENT_SYNC_DISABLED="$value" ;;
                "server_mode")            SERVER_MODE="$value" ;;
                "chat_enabled")           CHAT_ENABLED="$value" ;;
                "data_hydration")         DATA_HYDRATION="$value" ;;
                "show_ssl_tip")           SHOW_SSL_TIP="$value" ;;
            esac
        fi
    done < config.txt
    # Delete legacy config.txt after migration
    rm -f config.txt
    write_status "SUCCESS" "Migration complete. Deleted legacy config.txt"
else
    write_status "WARNING" "config.env not found, using default values"
fi

# =================================================================
# Firewall Information
# =================================================================
echo ""
write_status "INFO" "Ensure port $PORT is open in your firewall for network access"
echo ""

# =================================================================
# Get local IP address
# =================================================================
echo "Getting local IP address..."

LOCAL_IP="localhost"

# Try different methods to get IP based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
else
    # Linux
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$LOCAL_IP" ]; then
        LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' | head -n1)
    fi
    if [ -z "$LOCAL_IP" ]; then
        LOCAL_IP="localhost"
    fi
fi

# =================================================================
# Check for Tailscale (Active Connection)
# =================================================================
TAILSCALE_IP=""
TAILSCALE_URL=""

if command -v tailscale &> /dev/null; then
    # Check if Tailscale is actually running (backend state)
    if tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"'; then
        # Only consider it active if we have an IP
        TS_IP=$(tailscale ip -4 2>/dev/null)
        if [ ! -z "$TS_IP" ]; then
            TAILSCALE_IP="$TS_IP"
        
        # Try to get DNS name
        TS_DNS=$(tailscale status --json 2>/dev/null | grep -o '"DNSName": "[^"]*"' | head -n1 | cut -d'"' -f4 | sed 's/\.$//')
        
        # Fallback to cert filename if DNS lookup fails
        if [ -z "$TS_DNS" ]; then
             # Look for a cert file with a pattern like machine.tailnet.ts.net.crt
             TS_CRT=$(find cert res/cert res -name "*.ts.net.crt" 2>/dev/null | head -n1)
             if [ ! -z "$TS_CRT" ]; then
                 TS_DNS=$(basename "$TS_CRT" .crt)
             fi
        fi
        
        if [ ! -z "$TS_DNS" ]; then
            TAILSCALE_URL="https://${TS_DNS}:${PORT}"
        elif [ ! -z "$TAILSCALE_IP" ]; then
             # Fallback to IP if no DNS name found (though HTTPS might complain)
             TAILSCALE_URL="https://${TAILSCALE_IP}:${PORT}"
        fi
    fi
fi

# =================================================================
# Display server information
# =================================================================
echo ""
echo -e "\033[36mSync-Player 1.10.4\033[0m"
echo -e "\033[36m==========================\033[0m"
echo ""
echo -e "\033[33mSettings:\033[0m"
echo "- Server Port: $PORT"
echo "- Volume Step: ${VOLUME_STEP}%"
echo "- Skip Seconds: ${SKIP_SECONDS}s"
echo "- Join Mode: $JOIN_MODE"
echo "- HTTPS: $USE_HTTPS"
echo "- BSL-S2 Mode: $BSL_S2_MODE"
echo "- BSL-S2 Adv Match: $BSL_ADV_MATCH (Threshold: ${BSL_ADV_MATCH_THRESHOLD:-1})"
echo "- Skip Intro: ${SKIP_INTRO_SECONDS:-87}s"
echo "- Client Controls: ${CLIENT_CONTROLS_DISABLED:-false}"
echo "- Client Sync: ${CLIENT_SYNC_DISABLED:-false}"
echo "- Server Mode: ${SERVER_MODE:-false}"
echo "- Chat: ${CHAT_ENABLED:-true}"
echo "- Data Hydration: ${DATA_HYDRATION:-true}"
echo ""
echo -e "\033[33mAccess URLs:\033[0m"
PROTOCOL="http"

# Check for SSL certs in cert (priority), res/cert, res/, or root
# Check for SSL certs in cert (priority), res/cert, res/, or root
# Auto-detect if not manually enabled, OR if enabled but no file specified (optional robustness)

FOUND_CERT=""
FOUND_KEY=""

if [ "$USE_HTTPS" = "true" ]; then 
    PROTOCOL="https"
    # User manually enabled. Usage of specific file depends on env vars already set or server defaults.
elif [ -f "cert/cert.pem" ]; then
    PROTOCOL="https"
    USE_HTTPS="true"
    FOUND_CERT="cert/cert.pem"
    FOUND_KEY="cert/key.pem"
elif [ -f "res/cert/cert.pem" ]; then
    PROTOCOL="https"
    USE_HTTPS="true"
    FOUND_CERT="res/cert/cert.pem"
    FOUND_KEY="res/cert/key.pem"
elif [[ -n $(find cert -name "*.ts.net.crt" 2>/dev/null | head -n1) ]]; then
    PROTOCOL="https"
    USE_HTTPS="true"
    FOUND_CERT=$(find cert -name "*.ts.net.crt" 2>/dev/null | head -n1)
    # Derive key (replace .crt with .key)
    FOUND_KEY="${FOUND_CERT%.crt}.key"
elif [[ -n $(find res/cert -name "*.ts.net.crt" 2>/dev/null | head -n1) ]]; then
    PROTOCOL="https"
    USE_HTTPS="true"
    FOUND_CERT=$(find res/cert -name "*.ts.net.crt" 2>/dev/null | head -n1)
    FOUND_KEY="${FOUND_CERT%.crt}.key"
elif [ -f "res/cert.pem" ]; then
    PROTOCOL="https"
    USE_HTTPS="true"
    FOUND_CERT="res/cert.pem"
    FOUND_KEY="res/key.pem"
fi

if [ ! -z "$FOUND_CERT" ]; then
    export SYNC_SSL_CERT_FILE="$FOUND_CERT"
    # Only export key if we actually found/derived it and it exists (optional check)
    if [ ! -z "$FOUND_KEY" ]; then
        export SYNC_SSL_KEY_FILE="$FOUND_KEY"
    fi
fi

if [ "$USE_HTTPS" = "true" ]; then PROTOCOL="https"; fi

# =================================================================
# FINAL FALLBACK CHECK: If HTTPS is enabled via Tailscale cert but Tailscale is inactive -> Revert to HTTP
# =================================================================
# Check if config points to a TS cert OR if we auto-detected one
IS_TS_CERT=false
if [[ "$SSL_CERT_FILE" == *".ts.net"* ]] || [[ "$SSL_CERT_FILE" == *"tailscale"* ]]; then
    IS_TS_CERT=true
elif [ "$USE_HTTPS" = "true" ] && [[ -n $(find cert res/cert res -name "*.ts.net.crt" 2>/dev/null) ]]; then
    # If we are using HTTPS and a TS cert exists (and likely no other strictly prioritized non-TS cert invoked explicitly in config)
    # This is a heuristic. If user forced HTTPS in config but didn't specify file, and we found TS cert, start.sh might have picked it.
    # To be safe: if TS is inactive, and we seem to be relying on it, warn.
    IS_TS_CERT=true
fi

if [ "$USE_HTTPS" = "true" ] && [ "$IS_TS_CERT" = "true" ]; then
    if [ -z "$TAILSCALE_IP" ]; then
        echo ""
        echo -e "\033[33mWARNING: HTTPS is enabled with a Tailscale certificate, but Tailscale is NOT active.\033[0m"
        echo -e "\033[33m         Falling back to HTTP mode.\033[0m"
        echo ""
        
        USE_HTTPS="false"
        PROTOCOL="http"
        export SYNC_USE_HTTPS="false"
        # We don't unset the file vars because node app might crash if arguments missing? 
        # Actually server.js checks SYNC_USE_HTTPS first.
    fi
fi

if [ ! -z "$TAILSCALE_URL" ]; then
    echo "- Tailscale:       $TAILSCALE_URL"
    echo "- Tailscale Admin: $TAILSCALE_URL/admin"
else
    echo "- Your network:    ${PROTOCOL}://${LOCAL_IP}:${PORT}"
    echo "- Admin Panel:     ${PROTOCOL}://${LOCAL_IP}:${PORT}/admin"
fi
echo "- Testing purposes: ${PROTOCOL}://localhost:${PORT}"
echo ""
echo -e "\033[33mFirewall: Manual configuration may be required for network access\033[0m"
echo ""

if [ "$USE_HTTPS" != "true" ] && [ "${SHOW_SSL_TIP:-true}" != "false" ]; then
    echo "Tip: SSL generation scripts are available in cert/ for Tailscale/HTTPS support."
fi

echo ""



echo -e "\033[36mStarting Server...\033[0m"
echo ""
write_status "DEBUG" "Current directory: $PWD"
echo ""

# =================================================================
# Start the server (from res/ directory)
# =================================================================
if [ ! -f "res/server.js" ]; then
    write_status "CRITICAL" "res/server.js not found in current directory!"
    echo "Please ensure you are running this script from the correct folder."
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

write_status "DEBUG" "Starting server with port $PORT..."

# Clear retry counter on successful start
[ -f "$RETRY_FILE" ] && rm -f "$RETRY_FILE"

node --env-file-if-exists=config.env res/server.js "$LOCAL_IP"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    write_status "CRITICAL" "Server crashed with exit code $EXIT_CODE"
    echo "Please check the error messages above."
    echo ""
    read -p "Press Enter to exit..."
fi
