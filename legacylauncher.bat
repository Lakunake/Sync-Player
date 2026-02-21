@echo off
title Admin Console
color 0a
setlocal enabledelayedexpansion

:: last updated in 19.02.26 dd.mm.yy for compatibility reasons

:: =================================================================
:: Retry Counter (resets on computer reboot via TEMP folder)
:: =================================================================
set RETRY_FILE=%TEMP%\sync_player_retry_count.txt
set MAX_RETRIES=2

:: Check if retry file exists and read count
if exist "%RETRY_FILE%" (
    set /p RETRY_COUNT=<"%RETRY_FILE%"
) else (
    set RETRY_COUNT=0
)

:: =================================================================
:: Get script location and set working directory
:: =================================================================
set "batchdir=%~dp0"
cd /d "%batchdir%"
echo Running from: %cd%

:: =================================================================
:: Check Node.js installation
:: =================================================================
title Admin Console - Checking Node.js
echo Checking Node.js installation...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    color 0C
    echo ERROR: Node.js is not installed or not in PATH!
    color 0a
    echo Please download and install Node.js from:
    echo https://nodejs.org/
    echo Press Enter to download Node.js from here.
    pause >nul
    call winget install --id OpenJS.NodeJS.LTS -e
    echo.
)

:: =================================================================
:: Initialize configuration
:: =================================================================
title Admin Console - Initializing
if not exist config.env (
    echo Creating default configuration...
    (
        echo # ====================================
        echo # Sync-Player Environment Configuration
        echo # ====================================
        echo # Format: VARIABLE_NAME=value
        echo.
        echo # Server Settings
        echo SYNC_PORT=3000
        echo.
        echo # Playback Settings
        echo SYNC_VOLUME_STEP=5
        echo SYNC_SKIP_SECONDS=5
        echo SYNC_JOIN_MODE=sync
        echo.
        echo # HTTPS Configuration
        echo SYNC_USE_HTTPS=false
        echo SYNC_SSL_KEY_FILE=key.pem
        echo SYNC_SSL_CERT_FILE=cert.pem
        echo.
        echo # BSL-S2 Configuration
        echo SYNC_BSL_MODE=any
        echo.
        echo # Features
        echo SYNC_VIDEO_AUTOPLAY=false
        echo SYNC_ADMIN_FINGERPRINT_LOCK=false
        echo SYNC_CHAT_ENABLED=true
        echo SYNC_SERVER_MODE=false
    ) > config.env
    echo Default config created with all available options
)

:: =================================================================
:: Create folders if needed
:: =================================================================
if not exist media (
    mkdir media
    echo Created media directory
)

:: =================================================================
:: Check and Install Dependencies
:: =================================================================
title Admin Console - Checking Dependencies
echo Checking required dependencies...

:: Check Node.js dependencies (in res/ directory)
set MISSING_DEPS=0
if not exist res\node_modules (
    set MISSING_DEPS=1
    color 06
    echo [MISSING]: Node.js dependencies (express, socket.io, etc.)
    color 0a
) else (
    echo Checking for specific dependencies...
    if not exist "res\node_modules\express" (
        set MISSING_DEPS=1
        color 06
        echo [MISSING]: express package
        color 0a
    )
    if not exist "res\node_modules\socket.io" (
        set MISSING_DEPS=1
        color 06
        echo [MISSING]: socket.io package
        color 0a
    )
    if not exist "res\node_modules\helmet" (
        set MISSING_DEPS=1
        color 06
        echo [MISSING]: helmet package
        color 0a
    )
    if %MISSING_DEPS% equ 0 (
        echo [OK]: All Node.js dependencies found
    )
)

:: Check FFmpeg
set MISSING_FFMPEG=0
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    set MISSING_FFMPEG=1
    color 06
    echo [MISSING]: FFmpeg (required for video processing)
    color 0a
) else (
    echo [OK]: FFmpeg found
)

:: Ask user to install missing dependencies
if %MISSING_DEPS% equ 1 (
    echo.
    color 06
    echo [REQUIRED]: This software needs Node.js dependencies to work properly.
    echo Missing packages: express, socket.io, helmet, etc.
    color 0a
    echo.
    echo Press ENTER to install dependencies automatically, or Ctrl+C to exit.
    pause >nul
    echo.
    echo Installing Node.js dependencies...
    pushd res
    call npm install
    popd
    
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR]: Failed to install dependencies.
        color 0a
        echo Please check your internet connection and try again.
        echo You can also try running: npm install
        echo.
        
        :: Auto-retry logic
        if !RETRY_COUNT! lss %MAX_RETRIES% (
            set /a RETRY_COUNT+=1
            echo !RETRY_COUNT! > "%RETRY_FILE%"
            echo Retry attempt !RETRY_COUNT! of %MAX_RETRIES%...
            echo Restarting in 3 seconds...
            timeout /t 3 >nul
            start "" "%~f0"
            exit /b 0
        ) else (
            color 0C
            echo [CRITICAL]: Maximum retry attempts reached.
            echo Please fix the issue manually and restart the script.
            color 0a
            del "%RETRY_FILE%" >nul 2>&1
            pause
            exit /b 1
        )
    ) else (
        echo [SUCCESS]: Dependencies installed successfully.
        set MISSING_DEPS=0
        del "%RETRY_FILE%" >nul 2>&1
        color 0a
    )
)

:: Ask user about FFmpeg
if %MISSING_FFMPEG% equ 1 (
    echo.
    color 06
    echo [REQUIRED]: FFmpeg is not installed.
    echo FFmpeg is required for proper video processing and MKV support.
    color 0a
    echo.
    echo Press ENTER to download FFmpeg.
    pause >nul
    call winget install ffmpeg
    
    if %errorlevel% neq 0 (
        color 06
        echo [WARNING]: FFmpeg installation may have failed.
        echo MKV files might not work properly without FFmpeg.
        color 0a
        echo.
        
        :: Auto-retry logic for FFmpeg
        if !RETRY_COUNT! lss %MAX_RETRIES% (
            set /a RETRY_COUNT+=1
            echo !RETRY_COUNT! > "%RETRY_FILE%"
            echo Retry attempt !RETRY_COUNT! of %MAX_RETRIES%...
            echo Restarting in 3 seconds...
            timeout /t 3 >nul
            start "" "%~f0"
            exit /b 0
        ) else (
            color 06
            echo [WARNING]: Maximum retry attempts reached for FFmpeg.
            echo You can continue without FFmpeg, but some features may not work.
            color 0a
            del "%RETRY_FILE%" >nul 2>&1
            echo Press any key to continue anyway...
            pause >nul
        )
    ) else (
        del "%RETRY_FILE%" >nul 2>&1
    )
)

:: =================================================================
:: Read configuration
:: =================================================================
title Admin Console - Reading Config
set PORT=3000
set VOLUME_STEP=5
set SKIP_SECONDS=5
set JOIN_MODE=sync
set USE_HTTPS=false
set BSL_S2_MODE=any
set ADMIN_LOCK=false

:: Support both new SYNC_KEY=value AND legacy key: value format
if exist config.env (
    :: Try new format first (SYNC_KEY=value)
    for /f "tokens=1,* delims==" %%a in ('type config.env ^| findstr /v "^#" ^| findstr "="') do (
        if "%%a"=="SYNC_PORT" set PORT=%%b
        if "%%a"=="SYNC_VOLUME_STEP" set VOLUME_STEP=%%b
        if "%%a"=="SYNC_SKIP_SECONDS" set SKIP_SECONDS=%%b
        if "%%a"=="SYNC_JOIN_MODE" set JOIN_MODE=%%b
        if "%%a"=="SYNC_USE_HTTPS" set USE_HTTPS=%%b
        if "%%a"=="SYNC_BSL_MODE" set BSL_S2_MODE=%%b
        if "%%a"=="SYNC_ADMIN_FINGERPRINT_LOCK" set ADMIN_LOCK=%%b
    )
    :: Fallback: try legacy format (key: value)
    for /f "tokens=1,* delims=: " %%a in ('type config.env ^| findstr /v "^#" ^| findstr ":"') do (
        if "%%a"=="port" set PORT=%%b
        if "%%a"=="volume_step" set VOLUME_STEP=%%b
        if "%%a"=="skip_seconds" set SKIP_SECONDS=%%b
        if "%%a"=="join_mode" set JOIN_MODE=%%b
        if "%%a"=="use_https" set USE_HTTPS=%%b
        if "%%a"=="bsl_s2_mode" set BSL_S2_MODE=%%b
        if "%%a"=="admin_fingerprint_lock" set ADMIN_LOCK=%%b
    )
) else if exist config.txt (
    echo [WARNING]: Migrating from legacy config.txt...
    for /f "tokens=1,* delims=: " %%a in ('type config.txt ^| findstr /v "^#"') do (
        if "%%a"=="port" set PORT=%%b
        if "%%a"=="volume_step" set VOLUME_STEP=%%b
        if "%%a"=="skip_seconds" set SKIP_SECONDS=%%b
        if "%%a"=="join_mode" set JOIN_MODE=%%b
        if "%%a"=="use_https" set USE_HTTPS=%%b
        if "%%a"=="bsl_s2_mode" set BSL_S2_MODE=%%b
        if "%%a"=="admin_fingerprint_lock" set ADMIN_LOCK=%%b
    )
    del config.txt
    echo [SUCCESS]: Migration complete. Deleted legacy config.txt
) else (
    color 06
    echo [WARNING]: config.env not found, using default values
    color 0a
)


:: =================================================================
:: Firewall Information
:: =================================================================
title Admin Console - Firewall Info
echo.
echo [INFO]: Ensure port %PORT% is open in Windows Firewall for network access
echo.

:: =================================================================
:: Get local IP address
:: =================================================================
title Admin Console - Getting IP
echo Getting local IP address...
set LOCAL_IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4 Address"') do (
    set "LOCAL_IP=%%a"
    set LOCAL_IP=!LOCAL_IP: =!
    goto :ip_found
)

:ip_found
if "%LOCAL_IP%"=="" set LOCAL_IP=localhost

:: =================================================================
:: Display server information
:: =================================================================
title Admin Console
echo.
echo Sync-Player 1.10.4
echo ==========================
echo.
echo Settings:
echo - Server Port: %PORT%
echo - Volume Step: %VOLUME_STEP%%
echo - Skip Seconds: %SKIP_SECONDS%s
echo - Join Mode: %JOIN_MODE%
echo - HTTPS: %USE_HTTPS%
echo - BSL-S2 Mode: %BSL_S2_MODE%
echo - Admin Lock: %ADMIN_LOCK%
echo.
echo Access URLs:
echo - Your network: http://%LOCAL_IP%:%PORT%
echo - Admin Panel: http://%LOCAL_IP%:%PORT%/admin
echo - Testing purposes: http://localhost:%PORT%
echo.
echo Firewall: Manual configuration required for network access
echo.
echo Starting Server...
echo.
echo [DEBUG]: Current directory: %CD%
echo.
if not exist res\server.js (
    color 0C
    echo [CRITICAL ERROR]: res\server.js not found in current directory!
    echo Please ensure you are running this script from the correct folder.
    color 0a
    echo.
    pause
    exit /b 1
)
echo [DEBUG]: Starting server with port %PORT%...

:: Clear retry counter on successful start
del "%RETRY_FILE%" >nul 2>&1

node --env-file-if-exists=config.env res\server.js %LOCAL_IP%
if %errorlevel% neq 0 (
    echo.
    color 0C
    echo [CRITICAL ERROR]: Server crashed with exit code %errorlevel%
    echo Please check the error messages above.
    color 0a
    echo.
    pause
)