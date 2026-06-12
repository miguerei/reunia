# ReunIA - instalador de un comando para Windows (PowerShell)
#   irm https://reunia-pied.vercel.app/install.ps1 | iex
# Descarga el ultimo release desde GitHub y lanza el instalador.
$ErrorActionPreference = 'Stop'

$Repo = 'miguerei/reunia'
Write-Host "🎙️  Instalando ReunIA..." -ForegroundColor Cyan

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'ReunIA-Installer' }
$asset = $release.assets | Where-Object { $_.name -like '*Setup*.exe' } | Select-Object -First 1

if (-not $asset) {
    Write-Host "❌ No se encontró el instalador. Descarga manual: https://github.com/$Repo/releases/latest" -ForegroundColor Red
    exit 1
}

$installerPath = Join-Path $env:TEMP $asset.name
Write-Host "⬇️  Descargando $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath -UseBasicParsing

Write-Host "📦 Ejecutando el instalador (acepta el aviso de SmartScreen con 'Más información' → 'Ejecutar de todas formas')..."
Start-Process -FilePath $installerPath -Wait

Write-Host ""
Write-Host "✅ ReunIA instalada. Primer uso:" -ForegroundColor Green
Write-Host "   1. En Ajustes (se abre sola): pega tu clave de OpenAI o elige Ollama (local)."
Write-Host "   2. Para grabar Meet/Zoom completo instala VB-Cable: https://vb-audio.com/Cable/"
Write-Host "   3. Pulsa grabar (o Ctrl+Shift+R) y al terminar tendrás el informe con IA."
