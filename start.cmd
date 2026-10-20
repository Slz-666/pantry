@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo  家里有什么 - 启动服务
echo   手机  https://本机局域网IP:8443
echo   电脑  https://localhost:8443
echo   （本机 IP 用 ipconfig 看，必须和手机同一 WiFi）
echo ============================================
echo.
node server/src/index.js
echo.
echo 服务已退出（上面的报错信息可用于排查）
pause
