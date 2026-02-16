@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "..\res\generate-ssl.ps1" -OutputDir "."
