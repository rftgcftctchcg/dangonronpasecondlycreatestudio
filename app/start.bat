@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动视觉小说生成器...
echo 浏览器地址：http://127.0.0.1:3210
start "" "http://127.0.0.1:3210"
node server.js
pause
