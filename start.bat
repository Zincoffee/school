@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   校园活动与机会平台
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo        请先安装 Node 22 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo Node 版本：%NODEV%
echo 正在启动本地服务，启动后浏览器会自动打开…
echo 关闭本窗口即可停止服务。
echo.

rem 延迟 2 秒后在后台打开 Edge，避免服务尚未就绪时出现无法访问的页面
start "" cmd /c "timeout /t 2 /nobreak >nul & start msedge http://localhost:3000"

node server.js

echo.
echo 服务已停止。
pause
