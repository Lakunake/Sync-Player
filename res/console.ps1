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
 "Admin Console - Initializing"

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
if (-not (Test-Path "cert")) {
    New-Item -ItemType Directory -Path "cert" | Out-Null
    Write-Host "Created cert directory"
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
    SSL_KEY_FILE             = "key.pem"
    SSL_CERT_FILE            = "cert.pem"
    SKIP_FIREWALL_CHECK      = "false"
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
    "SYNC_SSL_KEY_FILE"              = "SSL_KEY_FILE"
    "SYNC_SSL_CERT_FILE"             = "SSL_CERT_FILE"
    "SYNC_SKIP_FIREWALL_CHECK"       = "SKIP_FIREWALL_CHECK"
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
# Fingerprint is stored in memory/memory.json
SYNC_ADMIN_FINGERPRINT_LOCK=false

# Firewall
# Set to true to skip automatic firewall rule checks/generation
SYNC_SKIP_FIREWALL_CHECK=false
"@
    $defaultEnv | Out-File -FilePath "config.env" -Encoding UTF8
    Write-Host "Default config.env created"
}

# =================================================================
# Check if Admin rights are needed (Firewall)
# =================================================================
if ($config.SKIP_FIREWALL_CHECK -ne "true") {
    $firewallRuleName = "Sync-Player-Port-$($config.PORT)"
    $ruleExists = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue

    if (-not $ruleExists) {
        # Rule is missing, we need admin to add it
        if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
            Write-Host ""
            Write-Host "Firewall rule for port $($config.PORT) is missing." -ForegroundColor Yellow
            Write-Host "Restarting as Administrator to add firewall rule..." -ForegroundColor Yellow
            Write-Host ""
            
            $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
            Start-Process powershell -Verb RunAs -ArgumentList $argList
            exit
        }
    }
}

# =================================================================
# Firewall Configuration
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Checking Firewall"
if ($config.SKIP_FIREWALL_CHECK -ne "true") {
    Write-Host "Checking Firewall rules..."

    $firewallRuleName = "Sync-Player-Port-$($config.PORT)"
    $ruleExists = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
    $ruleAdded = $false

    if (-not $ruleExists) {
        Write-Host "Adding Firewall rule for port $($config.PORT)..." -ForegroundColor Yellow
        try {
            New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -LocalPort $config.PORT -Protocol TCP -Action Allow -Profile Any | Out-Null
            Write-Status "SUCCESS" "Firewall rule added for port $($config.PORT)"
            $ruleAdded = $true
        } catch {
            Write-Status "ERROR" "Failed to add firewall rule: $_"
        }
    } else {
        Write-Status "OK" "Firewall rule exists"
    }
    
    # Notify user if the rule was just added (so they know why it might have paused or elevated)
    if ($ruleAdded) {
        Write-Host ""
        Write-Status "INFO" "A firewall rule was just added to allow access on port $($config.PORT)."
        Write-Host ""
    }
} else {
    Write-Host "Skipping firewall check (SYNC_SKIP_FIREWALL_CHECK=true)" -ForegroundColor Gray
    Write-Host ""
    # Since we skipped, we remind them to ensure it's open manually
    Write-Status "INFO" "Ensure port $($config.PORT) is open in Windows Firewall for network access"
    Write-Host ""
}

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
# Tailscale Detection & Auto-Config
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console - Checking Tailscale"

$Host.UI.RawUI.WindowTitle = "Admin Console - Checking Tailscale"

$TAILSCALE_IP = $null
$TAILSCALE_URL = $null

# 1. Try to detect Tailscale IP via CLI
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
    try {
        $tsStatus = tailscale status --json | ConvertFrom-Json
        if ($tsStatus.BackendState -eq "Running") {
             $possibleIP = $tsStatus.TailscaleIPs | Where-Object { $_ -match "^\d+\.\d+\.\d+\.\d+$" } | Select-Object -First 1
             
             # VERIFY: Ensure this IP is actually assigned to a local interface
             # (Fixes issue where 'tailscale status' reports IP but interface is down/APIPA)
             if ($possibleIP) {
                $localIPs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress
                if ($localIPs -contains $possibleIP) {
                    $TAILSCALE_IP = $possibleIP
                } else {
                    Write-Status "DEBUG" "Tailscale reports $possibleIP but it is not active on any interface. Assuming stopped."
                }
             }
        }
    } catch {}
}

# 2. Check for Tailscale certificates in cert/ OR res/cert/ OR res/ folder (Independent of CLI)
# Look for *.ts.net.crt or *.ts.net.pem
$tsCrt = Get-ChildItem -Path "cert", "res\cert", "res" -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\.ts\.net\.(crt|pem)$" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($tsCrt) {
    # Determine possible key names
    $tsKeyName1 = $tsCrt.Name -replace "\.(crt|pem)$", ".key"
    $tsKeyPath1 = Join-Path $tsCrt.DirectoryName $tsKeyName1
    
    $tsKeyName2 = $tsCrt.Name -replace "\.(crt|pem)$", ".pem"
    $tsKeyPath2 = Join-Path $tsCrt.DirectoryName $tsKeyName2
    
    $finalKeyPath = $null
    
    if (Test-Path $tsKeyPath1) { $finalKeyPath = $tsKeyPath1 }
    elseif (Test-Path $tsKeyPath2) { $finalKeyPath = $tsKeyPath2 }

    if ($finalKeyPath) {
        # Found valid pair
        if ($config.USE_HTTPS -eq "false") {
            Write-Host "Found Tailscale certificate: $($tsCrt.Name)" -ForegroundColor Green
            Write-Host "Automatically enabling HTTPS for this session." -ForegroundColor Green
            
            # Override config
            $config.USE_HTTPS = "true"
            # Use relative path from root if possible, or substantial path
            if ($tsCrt.DirectoryName.EndsWith("cert")) {
                 # Could be root/cert or res/cert
                 if ($tsCrt.DirectoryName -like "*\res\cert") {
                     $config.SSL_CERT_FILE = "res\cert\$($tsCrt.Name)"
                 } else {
                     $config.SSL_CERT_FILE = "cert\$($tsCrt.Name)"
                 }
            } else {
                 $config.SSL_CERT_FILE = "res\$($tsCrt.Name)"
            }
            $config.SSL_KEY_FILE = $finalKeyPath
            
            # Set environment variables
            $env:SYNC_USE_HTTPS = "true"
            $env:SYNC_SSL_CERT_FILE = $config.SSL_CERT_FILE
            $env:SYNC_SSL_KEY_FILE = $config.SSL_KEY_FILE
            $env:SYNC_SUBTITLE_RENDERER = "jassub"
        }
        
        # Update config to bind to 0.0.0.0 just in case server.js respects an env var (though it seems to ignore arg mostly)
        # But for display, we want to show the specific URL
        
        # Only set and display Tailscale URL if the network is actually active (IP detected)
        if ($TAILSCALE_IP) {
            if ($tsStatus.Self.DNSName) {
                # Use official DNS name (remove trailing dot)
                $tsHostname = $tsStatus.Self.DNSName.TrimEnd('.')
                $TAILSCALE_URL = "https://${tsHostname}:$($config.PORT)"
            } else {
                # Fallback to filename based parsing
                $tsHostname = $tsCrt.Name -replace "\.(crt|pem)$", ""
                $TAILSCALE_URL = "https://${tsHostname}:$($config.PORT)"
            }
            
            # ----------------------------------------------------------------
            # Auto-Fix: DNS Resolution via hosts file
            # ----------------------------------------------------------------
            try {
                # Check if hostname resolves to the Tailscale IP
                $resolvedIP = [System.Net.Dns]::GetHostAddresses($tsHostname) | Where-Object { $_.IPAddressToString -eq $TAILSCALE_IP } | Select-Object -First 1
                
                if (-not $resolvedIP) {
                    Write-Host "Detected DNS issue: '$tsHostname' does not resolve to '$TAILSCALE_IP'" -ForegroundColor Yellow
                    Write-Host "Attempting to fix by updating Windows hosts file..." -ForegroundColor Yellow
                    
                    $hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
                    $entries = Get-Content $hostsPath -ErrorAction SilentlyContinue
                    $entryToAdd = "$TAILSCALE_IP`t$tsHostname # Sync-Player Tailscale Fix"
                    
                    if (-not ($entries | Where-Object { $_ -match "$TAILSCALE_IP\s+$tsHostname" })) {
                        Add-Content -Path $hostsPath -Value $entryToAdd -Force
                        Write-Host "SUCCESS: Added '$tsHostname' to hosts file." -ForegroundColor Green
                        Write-Host "The URL https://${tsHostname}:$($config.PORT) should now work." -ForegroundColor Green
                    }
                }
            } catch {
                # If resolution throws an error (e.g. host not found), we should also try to fix
                 try {
                    $hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
                    $entryToAdd = "$TAILSCALE_IP`t$tsHostname # Sync-Player Tailscale Fix"
                    Add-Content -Path $hostsPath -Value $entryToAdd -Force
                    Write-Host "SUCCESS: Added entry to hosts file (DNS was failing)." -ForegroundColor Green
                 } catch {
                    Write-Host "WARNING: Could not update hosts file automatically. Run as Admin to fix." -ForegroundColor Red
                 }
            }
        }
    }
} 

# 3. Fallback URL using IP if no certs but IP detected (HTTP or whatever config is)
if (-not $TAILSCALE_URL -and $TAILSCALE_IP) {
     $protocol = if ($config.USE_HTTPS -eq "true") { "https" } else { "http" }
     $TAILSCALE_URL ="${protocol}://${TAILSCALE_IP}:$($config.PORT)"
}

# =================================================================
# FINAL FALLBACK CHECK: If HTTPS is enabled via Tailscale cert but Tailscale is inactive -> Revert to HTTP
# =================================================================
if ($config.USE_HTTPS -eq "true" -and ($config.SSL_CERT_FILE -match "\.ts\.net" -or $config.SSL_CERT_FILE -match "tailscale")) {
    if (-not $TAILSCALE_IP) {
        Write-Host ""
        Write-Host "WARNING: HTTPS is enabled with a Tailscale certificate, but Tailscale is NOT active." -ForegroundColor Yellow
        Write-Host "         Falling back to HTTP mode." -ForegroundColor Yellow
        Write-Host ""
        
        $config.USE_HTTPS = "false"
        $env:SYNC_USE_HTTPS = "false"
        $env:SYNC_SSL_CERT_FILE = $null
        $env:SYNC_SSL_KEY_FILE = $null
        
        # Reset protocol for display
        $protocol = "http"
        
        # Clear Tailscale URL if any remnant existed
        $TAILSCALE_URL = $null
    }
}

# =================================================================
# Display server information
# =================================================================
$Host.UI.RawUI.WindowTitle = "Admin Console"
Write-Host ""
Write-Host "Sync-Player 1.10.3" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Settings:" -ForegroundColor Yellow
Write-Host "- Server Port: $($config.PORT)" -ForegroundColor White
Write-Host "- Join Mode: $($config.JOIN_MODE)" -ForegroundColor White
Write-Host "- HTTPS: $($config.USE_HTTPS)" -ForegroundColor White
if ($config.USE_HTTPS -eq "true") {
    $certName = Split-Path $config.SSL_CERT_FILE -Leaf
    $keyName = Split-Path $config.SSL_KEY_FILE -Leaf
    Write-Host "- SSLs: $certName, $keyName" -ForegroundColor White
}
Write-Host "- BSL-S2 Mode: $($config.BSL_S2_MODE)" -ForegroundColor White
Write-Host "- Client Controls: $(if ($config.CLIENT_CONTROLS_DISABLED -eq 'true') { 'Disabled' } else { 'Enabled' })" -ForegroundColor White
Write-Host "- Client Sync: $(if ($config.CLIENT_SYNC_DISABLED -eq 'true') { 'Disabled' } else { 'Enabled' })" -ForegroundColor White
Write-Host "- Server Mode: $($config.SERVER_MODE)" -ForegroundColor White
Write-Host "- Chat: $($config.CHAT_ENABLED)" -ForegroundColor White
Write-Host "- Subtitle Renderer: $($config.SUBTITLE_RENDERER)" -ForegroundColor White
Write-Host ""
Write-Host "Access URLs:" -ForegroundColor Yellow
$protocol = if ($config.USE_HTTPS -eq "true") { "https" } else { "http" }

if ($TAILSCALE_URL) {
    Write-Host "- Tailscale:        $TAILSCALE_URL" -ForegroundColor White
    Write-Host "- Tailscale Admin:  $TAILSCALE_URL/admin" -ForegroundColor White
} else {
    Write-Host "- Your network:    ${protocol}://${LOCAL_IP}:$($config.PORT)" -ForegroundColor White
    Write-Host "- Admin Panel:     ${protocol}://${LOCAL_IP}:$($config.PORT)/admin" -ForegroundColor White
}
Write-Host "- Testing purposes: ${protocol}://localhost:$($config.PORT)" -ForegroundColor White
Write-Host ""

Write-Host ""
if ($config.USE_HTTPS -ne "true" -and $config.SHOW_SSL_TIP -ne "false") {
    Write-Host "Tip: SSL generation scripts are available in cert/ for Tailscale/HTTPS support." -ForegroundColor Gray
    Write-Host ""
}

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
