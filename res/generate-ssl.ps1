#!/usr/bin/env pwsh
# =============================================================================
# Sync-Player HTTPS Certificate Generator
# =============================================================================
# Generates a self-signed SSL certificate for enabling HTTPS
# Also updates config.env to enable HTTPS and JASSUB
#
# Usage: .\generate-ssl.ps1
# =============================================================================

param (
    [string]$OutputDir = ""
)

$Host.UI.RawUI.WindowTitle = "Sync-Player HTTPS Setup"
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Sync-Player HTTPS Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""


# Determine script and root directories
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Script is in res/, so root is one level up
$rootDir = Split-Path -Parent $scriptDir

# Default output location: root/cert/
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $rootDir "cert"
}

# Resolve absolute path for output (handle relative paths based on CURRENT location before we switch)
if (-not [System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir = Join-Path (Get-Location).Path $OutputDir
}

# Ensure cert directory exists (create if needed to resolve path)
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
    Write-Host "Created cert directory: $OutputDir" -ForegroundColor Gray
}

# Canonicalize path (remove relative segments)
$sslDir = (Get-Item -Path $OutputDir).FullName

# Ensure we are in the script directory (for relative path resolution if any)
Set-Location $scriptDir

$KeyFile = Join-Path $sslDir "key.pem"
$CertFile = Join-Path $sslDir "cert.pem"
$ConfigFile = Join-Path $rootDir "config.env"

# Get local IP for default values
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1).IPAddress
if (-not $localIP) { $localIP = "192.168.1.1" }

# Default certificate settings
$defaults = @{
    Country = "US"
    State = "State"
    City = "City"
    Organization = "Sync-Player"
    Unit = "Development"
    CommonName = "localhost"
    Days = 365
    IP = $localIP
}

# Check for OpenSSL first
$opensslPath = $null
$possiblePaths = @(
    "openssl",
    "C:\Program Files\Git\usr\bin\openssl.exe",
    "C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
    "C:\OpenSSL-Win64\bin\openssl.exe"
)

foreach ($path in $possiblePaths) {
    try {
        $null = & $path version 2>&1
        $opensslPath = $path
        break
    } catch {
        continue
    }
}

# Check for Tailscale
$tailscalePath = Get-Command "tailscale" -ErrorAction SilentlyContinue

if (-not $opensslPath -and -not $tailscalePath) {
    Write-Host "Neither OpenSSL nor Tailscale found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install one of the following:" -ForegroundColor Yellow
    Write-Host "  1. Tailscale: https://tailscale.com/download" -ForegroundColor Gray
    Write-Host "  2. Git for Windows (includes OpenSSL): https://git-scm.com/download/win" -ForegroundColor Gray
    Write-Host "  3. OpenSSL: https://slproweb.com/products/Win32OpenSSL.html" -ForegroundColor Gray
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

if ($opensslPath) { Write-Host "Using OpenSSL: $opensslPath" -ForegroundColor Gray }
if ($tailscalePath) { Write-Host "Found Tailscale: $($tailscalePath.Source)" -ForegroundColor Gray }
Write-Host ""

# Check if certificates already exist
if ((Test-Path $KeyFile) -and (Test-Path $CertFile)) {
    Write-Host "Existing certificates found in $($sslDir):" -ForegroundColor Yellow
    Write-Host "  - $KeyFile" -ForegroundColor Gray
    Write-Host "  - $CertFile" -ForegroundColor Gray
    Write-Host ""
    $response = Read-Host "Regenerate certificates? (y/N)"
    if ($response -ne "y" -and $response -ne "Y") {
        Write-Host "Keeping existing certificates." -ForegroundColor Green
        # Jump to config update
        $skipGeneration = $true
    }
    Write-Host ""
}

if (-not $skipGeneration) {
    # Setup mode selection
    Write-Host "Setup Mode:" -ForegroundColor Cyan
    if ($opensslPath) {
        Write-Host "  [1] Default - Quick setup with standard values (OpenSSL)" -ForegroundColor Gray
        Write-Host "  [2] Advanced - Customize certificate details (OpenSSL)" -ForegroundColor Gray
    }
    if ($tailscalePath) {
        Write-Host "  [3] Tailscale - Generate certificates using Tailscale" -ForegroundColor Gray
    }
    Write-Host ""

    $defaultMode = if ($opensslPath) { "1" } else { "3" }
    $mode = Read-Host "Select mode [$defaultMode]"
    if ([string]::IsNullOrWhiteSpace($mode)) { $mode = $defaultMode }
    Write-Host ""

    if ($mode -eq "3" -and $tailscalePath) {
        Write-Host "Generating Tailscale certificate..." -ForegroundColor Cyan
        try {
            # Retrieve the Tailscale domain name
            # Retrieve the Tailscale domain name
            $jsonRaw = tailscale status --json
            $tsStatus = $jsonRaw | ConvertFrom-Json
            
            if ($tsStatus.Self.DNSName) {
                $domain = $tsStatus.Self.DNSName.TrimEnd('.')
            } else {
                # Fallback: Try to construct from CertDomains or Hostname if available
                if ($tsStatus.CertDomains) {
                     $domain = $tsStatus.CertDomains[0].TrimEnd('.')
                }
            }
            
            if (-not $domain) {
                throw "Could not determine Tailscale domain name."
            }
            
            Write-Host "Domain: $domain" -ForegroundColor Cyan
            
            # Execute tailscale cert <domain>
            # Tailscale outputs to current directory, so we temporarily switch to sslDir
            Push-Location $sslDir
            try {
                $tsProcess = Start-Process -FilePath "tailscale" -ArgumentList "cert", $domain -NoNewWindow -Wait -PassThru
                if ($tsProcess.ExitCode -ne 0) {
                    throw "Tailscale command failed with exit code $($tsProcess.ExitCode)"
                }
                
                # Identify the generated files. They are typically <hostname>.<tailnet>.ts.net.crt/.key
                $newCrt = Get-ChildItem -Path . -Filter "*.crt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
                $newKey = Get-ChildItem -Path . -Filter "*.key" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
                
                if ($newCrt -and $newKey) {
                    # UPDATE GLOBAL VARIABLES TO POINT TO GENERATED FILES (for config update)
                    $KeyFile = $newKey.FullName
                    $CertFile = $newCrt.FullName

                    Write-Host "Tailscale certificates generated!" -ForegroundColor Green
                    Write-Host "  - Key:  $KeyFile" -ForegroundColor Gray
                    Write-Host "  - Cert: $CertFile" -ForegroundColor Gray
                } else {
                    throw "Could not locate generated Tailscale certificates."
                }
            } finally {
                Pop-Location
            }
            
            Write-Host ""
            Write-Host "Certificates are ready in '$sslDir'." -ForegroundColor Green
            Write-Host ""

        } catch {
            Write-Host "Failed to generate Tailscale certificates: $_" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }
    } elseif ($opensslPath) {
        $certSettings = $defaults.Clone()

        if ($mode -eq "2") {
            Write-Host "Advanced Setup - Press Enter for default value" -ForegroundColor Cyan
            Write-Host ""

            # Helper function to prompt with default
            function Read-WithDefault($prompt, $default) {
                $input = Read-Host "$prompt [$default]"
                if ([string]::IsNullOrWhiteSpace($input)) { return $default }
                return $input
            }

            $certSettings.Country = Read-WithDefault "Country Code (2 letters)" $defaults.Country
            $certSettings.State = Read-WithDefault "State/Province" $defaults.State
            $certSettings.City = Read-WithDefault "City" $defaults.City
            $certSettings.Organization = Read-WithDefault "Organization" $defaults.Organization
            $certSettings.Unit = Read-WithDefault "Organizational Unit" $defaults.Unit
            $certSettings.CommonName = Read-WithDefault "Common Name (hostname)" $defaults.CommonName
            $certSettings.Days = [int](Read-WithDefault "Certificate validity (days)" $defaults.Days)
            $certSettings.IP = Read-WithDefault "Local IP address" $defaults.IP
            Write-Host ""
        }

        Write-Host "Generating certificate with:" -ForegroundColor Cyan
        Write-Host "  Organization: $($certSettings.Organization)" -ForegroundColor Gray
        Write-Host "  Common Name: $($certSettings.CommonName)" -ForegroundColor Gray
        Write-Host "  Valid for: $($certSettings.Days) days" -ForegroundColor Gray
        Write-Host "  IP: $($certSettings.IP)" -ForegroundColor Gray
        Write-Host ""

        # Create OpenSSL config for SAN
        $opensslConfig = @"
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = $($certSettings.Country)
ST = $($certSettings.State)
L = $($certSettings.City)
O = $($certSettings.Organization)
OU = $($certSettings.Unit)
CN = $($certSettings.CommonName)

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = $($certSettings.IP)
"@

        $configPath = Join-Path $env:TEMP "openssl-sync-player.cnf"
        $opensslConfig | Out-File -FilePath $configPath -Encoding ASCII

        try {
            Write-Host "Generating certificate..." -ForegroundColor Cyan
            
            $opensslArgs = @(
                "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", $KeyFile,
                "-out", $CertFile,
                "-days", $certSettings.Days,
                "-nodes",
                "-config", $configPath
            )
            
            $process = Start-Process -FilePath $opensslPath -ArgumentList $opensslArgs -NoNewWindow -Wait -PassThru
            
            if ($process.ExitCode -ne 0) {
                throw "OpenSSL failed with exit code $($process.ExitCode)"
            }
            
            Write-Host ""
            Write-Host "Certificates generated successfully!" -ForegroundColor Green
            Write-Host "  - Key:  $KeyFile" -ForegroundColor Gray
            Write-Host "  - Cert: $CertFile" -ForegroundColor Gray
            Write-Host "  - Valid for: $($certSettings.Days) days" -ForegroundColor Gray
            Write-Host ""
            Write-Host "Certificates are ready in '$sslDir'." -ForegroundColor Green
            Write-Host ""
            
        } catch {
            Write-Host "Failed to generate certificate: $_" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        } finally {
            if (Test-Path $configPath) {
                Remove-Item $configPath -Force
            }
        }
    } else {
        Write-Host "Invalid mode selected or required tool missing." -ForegroundColor Red
        exit 1
    }
}

# Update config.env
Write-Host "Updating config.env..." -ForegroundColor Cyan

if (Test-Path $ConfigFile) {
    $content = Get-Content $ConfigFile -Raw
    
    # Enable HTTPS
    $content = $content -replace "SYNC_USE_HTTPS=false", "SYNC_USE_HTTPS=true"
    
    # Set JASSUB renderer
    if ($content -match "SYNC_SUBTITLE_RENDERER=wsr") {
        $content = $content -replace "SYNC_SUBTITLE_RENDERER=wsr", "SYNC_SUBTITLE_RENDERER=jassub"
    }

    # Update Cert/Key paths (use relative path if inside root, else absolute)
    try {
        $relKey = $KeyFile
        $relCert = $CertFile
        
        # Try to make relative to root if possible
        if ($KeyFile.StartsWith($rootDir)) {
            $relKey = $KeyFile.Substring($rootDir.Length).TrimStart('\', '/')
            # Ensure forward slashes for config compatibility
            $relKey = $relKey -replace '\\', '/'
        }
        if ($CertFile.StartsWith($rootDir)) {
            $relCert = $CertFile.Substring($rootDir.Length).TrimStart('\', '/')
            $relCert = $relCert -replace '\\', '/'
        }

        # Update or Add Key File
        if ($content -match "SYNC_SSL_KEY_FILE=.*") {
            $content = $content -replace "SYNC_SSL_KEY_FILE=.*", "SYNC_SSL_KEY_FILE=$relKey"
        } else {
            $content += "`nSYNC_SSL_KEY_FILE=$relKey"
        }

        # Update or Add Cert File
        if ($content -match "SYNC_SSL_CERT_FILE=.*") {
            $content = $content -replace "SYNC_SSL_CERT_FILE=.*", "SYNC_SSL_CERT_FILE=$relCert"
        } else {
            $content += "`nSYNC_SSL_CERT_FILE=$relCert"
        }
        
        Write-Host "  - SYNC_SSL_KEY_FILE=$relKey" -ForegroundColor Green
        Write-Host "  - SYNC_SSL_CERT_FILE=$relCert" -ForegroundColor Green

    } catch {
        Write-Host "  Warning: Failed to update certificate paths in config: $_" -ForegroundColor Yellow
    }
    
    $content | Set-Content $ConfigFile -NoNewline
    
    Write-Host "  - SYNC_USE_HTTPS=true" -ForegroundColor Green
    Write-Host "  - SYNC_SUBTITLE_RENDERER=jassub" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "  config.env not found, skipping config update" -ForegroundColor Yellow
    Write-Host ""
}

# Display IP for final message
if (-not $certSettings) { $certSettings = $defaults }

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Setup Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart Sync-Player" -ForegroundColor Gray
Write-Host "  2. Access via given links" -ForegroundColor Gray
Write-Host "  2,1. Accept the certificate warning in your browser" -ForegroundColor Gray
Write-Host ""
Write-Host "Note: Clients may see a browser warning because this is a" -ForegroundColor Gray
Write-Host "self-signed certificate. This is normal for LAN use." -ForegroundColor Gray
Write-Host "Click 'Advanced' > 'Proceed to site' to continue." -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to exit"
