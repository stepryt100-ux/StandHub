@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js не установлен. Скачайте с https://nodejs.org и установите, потом запустите этот файл снова. & start https://nodejs.org & pause & exit)
start "" http://localhost:3000
node server.js
pause
