@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Envia o kit para https://github.com/Luanbc/evo (rode com dois cliques).
rem Na primeira vez, o Git abre o navegador para voce entrar na sua conta do GitHub.
set "URL=https://github.com/Luanbc/evo.git"
where git >nul 2>nul || (echo Git nao encontrado. Instale em https://git-scm.com/download/win & pause & exit /b 1)
if not exist ".git" git init -b main
git add -A
git update-index --chmod=+x scripts/evo.sh scripts/monitor.sh scripts/preparar-servidor.sh
git config user.email >nul 2>nul || git config user.email "Luanbc@users.noreply.github.com"
git config user.name >nul 2>nul || git config user.name "Luanbc"
git commit -m "Atualizacao do kit (%date%)" || echo Nada novo para registrar.
git remote get-url origin >nul 2>nul || git remote add origin %URL%
git push -u origin main
if errorlevel 1 (echo. & echo O envio falhou. Confira se voce tem acesso ao repositorio e tente de novo.) else (echo. & echo Pronto: https://github.com/Luanbc/evo)
pause
