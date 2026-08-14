@echo off
chcp 65001 > nul
echo ========================================================
echo   Kuromoon Local Pipeline Auto-Runner
echo ========================================================
cd /d "%~dp0web"
node pipeline/run-all.js --push
echo ========================================================
echo   Finished at %DATE% %TIME%
echo ========================================================
