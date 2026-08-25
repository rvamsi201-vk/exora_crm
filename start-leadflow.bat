@echo off
echo Stopping existing processes...
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1
timeout /t 2

echo Starting LeadFlow App...
start "LeadFlow App" cmd /k "cd C:\Users\win11\Downloads\Exora_Crm\exora_crm && npm start"
timeout /t 5

echo Starting ngrok...
start "ngrok" cmd /k "ngrok http --domain=esmeralda-nacred-lostly.ngrok-free.dev 3001"

echo.
echo LeadFlow is running!
echo App    → http://localhost:3001
echo Public → https://esmeralda-nacred-lostly.ngrok-free.dev
pause