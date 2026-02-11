# Sync-Player PowerShell Startup Script
# Equivalent to legacylauncher.bat with improved error handling and cleaner syntax, legacy launcher will no longer get major updates

# Re-launch with bypass if not already bypassed (fixes right-click "Run with PowerShell")
if ($ExecutionContext.SessionState.LanguageMode -eq 'ConstrainedLanguage' -or 
    (Get-ExecutionPolicy) -notin @('Bypass', 'Unrestricted', 'RemoteSigned')) {
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoProfile -File `"$PSCommandPath`"" -NoNewWindow -Wait
    exit
}

# Prefer Windows Terminal
if (-not $env:WT_SESSION -and (Get-Command wt -ErrorAction SilentlyContinue)) {
    Start-Process wt -ArgumentList "-w -1 nt --title `"Sync-Player Admin Console`" powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$Host.UI.RawUI.WindowTitle = "Admin Console"
$ErrorActionPreference = "Stop"

# =================================================================
# Retry Counter (resets on computer reboot via TEMP folder)
# =================================================================
$RETRY_FILE = "$env:TEMP\sync_player_retry_count.txt"
$MAX_RETRIES = 2
$RETRY_COUNT = 0

if (Test-Path $RETRY_FILE) {
    $RETRY_COUNT = [int](Get-Content $RETRY_FILE -Raw)
}

# =================================================================
# Get script location and set working directory
# Script is in res/, root is parent folder
# =================================================================
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
Set-Location $rootDir
Write-Host "Running from: $PWD"
Write-Host "Script location: $scriptDir"

# =================================================================
# Helper function for colored output
# =================================================================
function Write-Status {
    param(
        [string]$Type,
        [string]$Message
    )
    switch ($Type) {
        "OK" { Write-Host "[OK]: $Message" -ForegroundColor DarkCyan }
        "MISSING" { Write-Host "[MISSING]: $Message" -ForegroundColor Yellow }
        "WARNING" { Write-Host "[WARNING]: $Message" -ForegroundColor Yellow }
        "ERROR" { Write-Host "[ERROR]: $Message" -ForegroundColor Red }
        "CRITICAL" { Write-Host "[CRITICAL]: $Message" -ForegroundColor Red }
        "INFO" { Write-Host "[INFO]: $Message" -ForegroundColor Cyan }
        "SUCCESS" { Write-Host "[SUCCESS]: $Message" -ForegroundColor Green }
        "REQUIRED" { Write-Host "[REQUIRED]: $Message" -ForegroundColor Yellow }
        "DEBUG" { Write-Host "[DEBUG]: $Message" -ForegroundColor Gray }
        default { Write-Host $Message }
    }
}

# =================================================================
# Check Node.js installation
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Checking Node.js"
Write-Host "Checking Node.js installation..."

$nodeInstalled = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeInstalled) {
    Write-Host ""
    Write-Status "ERROR" "Node.js is not installed or not in PATH!"
    Write-Host "Press Enter to install Node.js via winget, or Ctrl+C to exit and install manually."
    Write-Host "Manual download: https://nodejs.org/en/download" -ForegroundColor Cyan
    Read-Host
    
    try {
        winget install --id OpenJS.NodeJS.LTS -e
        if ($LASTEXITCODE -ne 0) {
            throw "winget install failed with exit code $LASTEXITCODE"
        }
        Write-Status "SUCCESS" "Node.js installed. Please restart this script."
        Read-Host "Press Enter to exit"
        exit 0
    }
    catch {
        Write-Status "ERROR" "Failed to install Node.js via winget."
        Write-Host "Please install manually from: https://nodejs.org/en/download" -ForegroundColor Cyan
        Write-Host "After installing, restart this script."
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# =================================================================
# Initialize configuration (in root directory)
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Initializing"

# =================================================================
# Initialize configuration (in root directory)
# =================================================================
# Config creation is now handled in the 'Read configuration' phase if no config exists

# =================================================================
# Create folders if needed (in root directory)
# =================================================================
if (-not (Test-Path "media")) {
    New-Item -ItemType Directory -Path "media" | Out-Null
    Write-Host "Created media directory"
}
if (-not (Test-Path "res\tracks")) {
    New-Item -ItemType Directory -Path "res\tracks" | Out-Null
    Write-Host "Created res\tracks directory"
}
if (-not (Test-Path "memory\tracks")) {
    New-Item -ItemType Directory -Path "memory\tracks" | Out-Null
    Write-Host "Created memory\tracks directory"
}

# =================================================================
# Check and Install Dependencies (in res/ directory)
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Checking Dependencies"
Write-Host "Checking required dependencies..."

$MISSING_DEPS = $false
$requiredPackages = @("express", "socket.io", "helmet", "express-rate-limit", "rate-limiter-flexible", "cookie-parser", "node-av", "fast-deep-equal")

if (-not (Test-Path "res\node_modules")) {
    $MISSING_DEPS = $true
    Write-Status "MISSING" "Node.js dependencies (express, socket.io, etc.)"
}
else {
    Write-Host "Checking for specific dependencies..."
    foreach ($pkg in $requiredPackages) {
        if (-not (Test-Path "res\node_modules\$pkg")) {
            $MISSING_DEPS = $true
            Write-Status "MISSING" "$pkg package"
        }
    }
    if (-not $MISSING_DEPS) {
        Write-Status "OK" "All Node.js dependencies found"
    }
}

# Check FFmpeg
# Check FFmpeg (Skip if node-av is installed)
if (Test-Path "res\node_modules\node-av") {
    Write-Status "OK" "FFmpeg bundled with node-av"
    $MISSING_FFMPEG = $false
}
else {
    $ffmpegInstalled = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $ffmpegInstalled) {
        $MISSING_FFMPEG = $true
        Write-Status "MISSING" "FFmpeg"
    }
    else {
        Write-Status "OK" "FFmpeg found"
    }
}

# Install missing Node.js dependencies (run npm from res/ directory)
if ($MISSING_DEPS) {
    Write-Host ""
    Write-Status "REQUIRED" "This software needs Node.js dependencies to work properly."
    Write-Status "INFO" "Installing dependencies from package.json..."
    Write-Host ""
    Write-Host "Press ENTER to install dependencies automatically, or Ctrl+C to exit."
    Read-Host
    Write-Host ""
    Write-Host "Installing Node.js dependencies..."
    
    try {
        Write-Host "Running: npm install" -ForegroundColor Gray
        Write-Host ""
        Push-Location "res"
        cmd /c "npm install"
        cmd /c "npm audit fix"
        Pop-Location
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE"
        }
        Write-Host ""
        Write-Status "SUCCESS" "Dependencies installed successfully."
        $MISSING_DEPS = $false
        if (Test-Path $RETRY_FILE) { Remove-Item $RETRY_FILE -Force }
    }
    catch {
        Pop-Location -ErrorAction SilentlyContinue
        Write-Status "ERROR" "Failed to install dependencies."
        Write-Host "Please check your internet connection and try again."
        Write-Host "You can also try running: cd res && npm install"
        Write-Host ""
        
        # Auto-retry logic
        if ($RETRY_COUNT -lt $MAX_RETRIES) {
            $RETRY_COUNT++
            $RETRY_COUNT | Out-File -FilePath $RETRY_FILE -Force
            Write-Host "Retry attempt $RETRY_COUNT of $MAX_RETRIES..."
            Write-Host "Restarting in 3 seconds..."
            Start-Sleep -Seconds 3
            Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
            exit 0
        }
        else {
            Write-Status "CRITICAL" "Maximum retry attempts reached."
            Write-Host "Please fix the issue manually and restart the script."
            if (Test-Path $RETRY_FILE) { Remove-Item $RETRY_FILE -Force }
            Read-Host "Press Enter to exit"
            exit 1
        }
    }
}

if ($MISSING_FFMPEG) {
    Write-Host ""
    Write-Status "REQUIRED" "FFmpeg is not installed."
    Write-Host "FFmpeg is required for video thumbnails and MKV support."
    Write-Host ""
    Write-Host "Press ENTER to install FFmpeg via winget, or Ctrl+C to install manually."
    Write-Host "Manual download: https://ffmpeg.org/download.html" -ForegroundColor Cyan
    Read-Host
    
    try {
        winget install --id Gyan.FFmpeg -e
        if ($LASTEXITCODE -ne 0) {
            throw "winget install failed with exit code $LASTEXITCODE"
        }
        Write-Status "SUCCESS" "FFmpeg installed successfully."
        Write-Host "You may need to restart this script for FFmpeg to be detected."
        if (Test-Path $RETRY_FILE) { Remove-Item $RETRY_FILE -Force }
    }
    catch {
        Write-Status "WARNING" "FFmpeg installation via winget failed."
        Write-Host "Please install manually from: https://ffmpeg.org/download.html" -ForegroundColor Cyan
        Write-Host "For Windows, download from: https://www.gyan.dev/ffmpeg/builds/" -ForegroundColor Cyan
        Write-Host "Make sure to add FFmpeg to your system PATH."
        Write-Host ""
        Write-Host "You can continue without FFmpeg, but thumbnails and some features won't work."
        Write-Host "Press Enter to continue anyway..."
        Read-Host
    }
}

# =================================================================
# Read configuration (from root directory)
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Reading Config"

# Default values
$config = @{
    PORT                     = 3000
    VOLUME_STEP              = 5
    SKIP_SECONDS             = 5
    JOIN_MODE                = "sync"
    USE_HTTPS                = "false"
    BSL_S2_MODE              = "any"
    ADMIN_LOCK               = "false"
    BSL_ADV_MATCH            = "true"
    BSL_ADV_MATCH_THRESHOLD  = 1
    SKIP_INTRO_SECONDS       = 87
    CLIENT_CONTROLS_DISABLED = "false"
    CLIENT_SYNC_DISABLED     = "false"
    SERVER_MODE              = "false"
    CHAT_ENABLED             = "true"
    DATA_HYDRATION           = "true"
    SUBTITLE_RENDERER        = "wsr"
}

# Helper to map env vars to config keys
$envMap = @{
    "SYNC_PORT"                      = "PORT"
    "SYNC_VOLUME_STEP"               = "VOLUME_STEP"
    "SYNC_SKIP_SECONDS"              = "SKIP_SECONDS"
    "SYNC_JOIN_MODE"                 = "JOIN_MODE"
    "SYNC_USE_HTTPS"                 = "USE_HTTPS"
    "SYNC_BSL_MODE"                  = "BSL_S2_MODE"
    "SYNC_ADMIN_FINGERPRINT_LOCK"    = "ADMIN_LOCK"
    "SYNC_BSL_ADVANCED_MATCH"        = "BSL_ADV_MATCH"
    "SYNC_BSL_MATCH_THRESHOLD"       = "BSL_ADV_MATCH_THRESHOLD"
    "SYNC_SKIP_INTRO_SECONDS"        = "SKIP_INTRO_SECONDS"
    "SYNC_CLIENT_CONTROLS_DISABLED"  = "CLIENT_CONTROLS_DISABLED"
    "SYNC_CLIENT_SYNC_DISABLED"      = "CLIENT_SYNC_DISABLED"
    "SYNC_SERVER_MODE"               = "SERVER_MODE"
    "SYNC_CHAT_ENABLED"              = "CHAT_ENABLED"
    "SYNC_DATA_HYDRATION"            = "DATA_HYDRATION"
    "SYNC_SUBTITLE_RENDERER"         = "SUBTITLE_RENDERER"
}

# 1. Read config.env (Primary)
if (Test-Path "config.env") {
    $envContent = Get-Content "config.env"
    foreach ($line in $envContent) {
        if ($line -match "^\s*#") { continue } # Skip comments
        if ($line -match "^\s*([^=]+?)\s*=\s*(.*)\s*$") {
            $key = $matches[1].Trim()
            $val = $matches[2].Trim()
            
            if ($envMap.ContainsKey($key)) {
                $configKey = $envMap[$key]
                # Type conversion for integers
                if ($configKey -match "(PORT|VOLUME|SECONDS|THRESHOLD)") {
                    try { $config[$configKey] = [int]$val } catch {}
                } else {
                    $config[$configKey] = $val
                }
            }
        }
    }
    # Write-Host "Configuration loaded from config.env" -ForegroundColor Cyan
}
# 2. Migrate from legacy config.txt (if exists)
elseif (Test-Path "config.txt") {
    Write-Host "Migrating from legacy config.txt..." -ForegroundColor Yellow
    $configContent = Get-Content "config.txt"
    foreach ($line in $configContent) {
        if ($line -match "^\s*#" -or $line -match "^\s*$") { continue }
        if ($line -match "^\s*(\w+)\s*:\s*(.+?)\s*$") {
            $key = $matches[1]
            $value = $matches[2]
            
            switch ($key) {
                "port" { $config.PORT = [int]$value }
                "volume_step" { $config.VOLUME_STEP = [int]$value }
                "skip_seconds" { $config.SKIP_SECONDS = [int]$value }
                "join_mode" { $config.JOIN_MODE = $value }
                "use_https" { $config.USE_HTTPS = $value }
                "bsl_s2_mode" { $config.BSL_S2_MODE = $value }
                "admin_fingerprint_lock" { $config.ADMIN_LOCK = $value }
                "bsl_advanced_match" { $config.BSL_ADV_MATCH = $value }
                "bsl_advanced_match_threshold" { $config.BSL_ADV_MATCH_THRESHOLD = [int]$value }
                "skip_intro_seconds" { $config.SKIP_INTRO_SECONDS = [int]$value }
                "client_controls_disabled" { $config.CLIENT_CONTROLS_DISABLED = $value }
                "client_sync_disabled" { $config.CLIENT_SYNC_DISABLED = $value }
                "server_mode" { $config.SERVER_MODE = $value }
                "chat_enabled" { $config.CHAT_ENABLED = $value }
                "data_hydration" { $config.DATA_HYDRATION = $value }
            }
        }
    }
    # Delete the old config.txt after migration
    Remove-Item "config.txt" -Force
    Write-Host "Migration complete. Deleted legacy config.txt" -ForegroundColor Green
}
else {
    # Create default config.env if nothing exists
    Write-Host "Creating default configuration (config.env)..."
    
    $defaultEnv = @"
# ====================================
# Sync-Player Environment Configuration
# ====================================
# Format: VARIABLE_NAME=value

# Server Settings
SYNC_PORT=3000

# Playback Settings
SYNC_VOLUME_STEP=5
SYNC_MAX_VOLUME=100
SYNC_SKIP_SECONDS=5
SYNC_SKIP_INTRO_SECONDS=87
SYNC_VIDEO_AUTOPLAY=false
SYNC_JOIN_MODE=sync

# Features
SYNC_CHAT_ENABLED=true
SYNC_DATA_HYDRATION=true
SYNC_SERVER_MODE=false

# Client Controls
SYNC_CLIENT_CONTROLS_DISABLED=false
SYNC_CLIENT_SYNC_DISABLED=false

# BSL-S² Sync
SYNC_BSL_MODE=any
SYNC_BSL_ADVANCED_MATCH=true
SYNC_BSL_MATCH_THRESHOLD=1

# Security
SYNC_USE_HTTPS=false
SYNC_SSL_KEY_FILE=key.pem
SYNC_SSL_CERT_FILE=cert.pem
SYNC_ADMIN_FINGERPRINT_LOCK=false
"@
    $defaultEnv | Out-File -FilePath "config.env" -Encoding UTF8
    Write-Host "Default config.env created"
}

# =================================================================
# Firewall Information
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Firewall Info"
Write-Host ""
Write-Status "INFO" "Ensure port $($config.PORT) is open in Windows Firewall for network access"
Write-Host ""

# =================================================================
# Get local IP address
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Getting IP"
Write-Host "Getting local IP address..."

$LOCAL_IP = "localhost"
try {
    # Use same method as batch file - parse ipconfig
    $ipconfigOutput = ipconfig | Select-String "IPv4 Address"
    foreach ($line in $ipconfigOutput) {
        if ($line -match ":\s*(\d+\.\d+\.\d+\.\d+)") {
            $foundIP = $matches[1]
            # Skip link-local addresses (169.254.x.x) and loopback
            if ($foundIP -notmatch "^(169\.254\.|127\.)") {
                $LOCAL_IP = $foundIP
                break
            }
            # If we only find 169.254, use it as fallback
            if ($LOCAL_IP -eq "localhost") {
                $LOCAL_IP = $foundIP
            }
        }
    }
}
catch {
    Write-Status "WARNING" "Could not detect IP, using localhost"
}

# =================================================================
# Display server information
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console"
Write-Host ""
Write-Host "Sync-Player 1.10.2" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Settings:" -ForegroundColor Yellow
Write-Host "- Server Port: $($config.PORT)" -ForegroundColor White
Write-Host "- Join Mode: $($config.JOIN_MODE)" -ForegroundColor White
Write-Host "- HTTPS: $($config.USE_HTTPS)" -ForegroundColor White
Write-Host "- BSL-S2 Mode: $($config.BSL_S2_MODE)" -ForegroundColor White
Write-Host "- Client Controls: $(if ($config.CLIENT_CONTROLS_DISABLED -eq 'true') { 'Disabled' } else { 'Enabled' })" -ForegroundColor White
Write-Host "- Client Sync: $(if ($config.CLIENT_SYNC_DISABLED -eq 'true') { 'Disabled' } else { 'Enabled' })" -ForegroundColor White
Write-Host "- Server Mode: $($config.SERVER_MODE)" -ForegroundColor White
Write-Host "- Chat: $($config.CHAT_ENABLED)" -ForegroundColor White
Write-Host "- Subtitle Renderer: $($config.SUBTITLE_RENDERER)" -ForegroundColor White
Write-Host ""
Write-Host "Access URLs:" -ForegroundColor Yellow
$protocol = if ($config.USE_HTTPS -eq "true") { "https" } else { "http" }
Write-Host "- Your network: ${protocol}://${LOCAL_IP}:$($config.PORT)" -ForegroundColor White
Write-Host "- Admin Panel: ${protocol}://${LOCAL_IP}:$($config.PORT)/admin" -ForegroundColor White
Write-Host "- Testing purposes: ${protocol}://localhost:$($config.PORT)" -ForegroundColor White
Write-Host ""
Write-Host "Firewall: Manual configuration required for network access" -ForegroundColor Yellow
Write-Host ""
Write-Host "Starting Server..." -ForegroundColor Cyan
Write-Host ""
Write-Status "DEBUG" "Current directory: $PWD"
Write-Host ""

# =================================================================
# Start the server (from res/ directory)
# =================================================================
if (-not (Test-Path "res\server.js")) {
    Write-Status "CRITICAL" "res\server.js not found!"
    Write-Host "Please ensure you are running this script from the correct folder."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# Clear retry counter on successful start
if (Test-Path $RETRY_FILE) { Remove-Item $RETRY_FILE -Force }

try {
    & node --env-file-if-exists=config.env res\server.js $LOCAL_IP
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Server exited with code $exitCode"
    }
}
catch {
    Write-Host ""
    Write-Status "CRITICAL" "Server crashed: $_"
    Write-Host "Please check the error messages above."
    Write-Host ""
    Read-Host "Press Enter to exit"
}
