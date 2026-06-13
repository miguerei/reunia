# ReunIA - instalador de un comando para Windows (PowerShell)
#   irm https://raw.githubusercontent.com/miguerei/reunia/main/install.ps1 | iex
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
Write-Host "   1. En Ajustes (se abre sola): elige Gemini (GRATIS, clave en 30s) u Ollama (local), o pega tu clave de OpenAI."
Write-Host "   2. Tu microfono ya graba. Para capturar tambien a los demas en videollamadas, instala VB-Cable (https://vb-audio.com/Cable/) y usalo como 'audio del sistema'."
Write-Host "   3. Pulsa grabar (o Ctrl+Shift+R). Durante la reunion, prueba el boton 'Resumen ultimos minutos' (Coach IA)."
