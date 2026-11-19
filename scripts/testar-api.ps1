# Envia fotos (e clipes, áudio e logo, opcionais) para a API e baixa o vídeo pronto.
#
# Uso (PowerShell no Windows; usa o curl.exe que já vem no Windows 10/11):
#   .\scripts\testar-api.ps1 -Url https://SEU-DOMINIO -Chave vea_... -Pasta C:\fotos
#   .\scripts\testar-api.ps1 -Url ... -Chave ... -Pasta C:\fotos -Audio C:\musica.mp3 -Inicio 30 -Duracao 20 -Logo C:\logo.png
#   .\scripts\testar-api.ps1 -Url ... -Chave ... -Pasta C:\fotos -Clima calmo -Duracao 20     (música da biblioteca)
#
# A pasta pode ter JPEG, PNG, WebP e vídeos (MP4, MOV). Arquivos de áudio são ignorados.
#
# ORDEM: todas as imagens e vídeos da pasta entram no vídeo, em ordem alfabética do nome.
#   Numere com dois dígitos para controlar: 01-chegada.jpg, 02-aquecimento.jpg, ... 10-podio.jpg
#   (sem o zero, "10" viria antes de "2").
# LOGO: deixe fora da pasta das fotos e passe com -Logo (ou -Parceiro). Dentro da pasta, ela
#   entraria no vídeo como uma foto comum.

param(
  [Parameter(Mandatory = $true)] [string] $Url,
  [Parameter(Mandatory = $true)] [string] $Chave,
  [Parameter(Mandatory = $true)] [string] $Pasta,
  [string] $Audio,
  [string] $MusicaId,
  [string] $Clima,
  [double] $Inicio = 0,
  [double] $Duracao = 0,
  [string] $Logo,
  [string] $Parceiro,
  [string] $Titulo,
  [string] $Preset = "limpo",
  [string] $Plataforma = "instagram_reels",
  [switch] $SomDosClipes,
  [string] $Saida = ".\video.mp4"
)

$ErrorActionPreference = "Stop"
$Url = $Url.TrimEnd("/")
$fotos = @(".jpg", ".jpeg", ".png", ".webp")
$videos = @(".mp4", ".mov", ".m4v", ".webm")

$arquivos = Get-ChildItem -LiteralPath $Pasta -File |
  Where-Object { ($fotos + $videos) -contains $_.Extension.ToLower() } |
  Sort-Object Name
if ($arquivos.Count -eq 0) { throw "Nenhuma foto ou vídeo em $Pasta" }

$campos = @()
$itens = @()
$i = 0
foreach ($a in $arquivos) {
  $i++
  $nome = "item$i"
  $campos += @("-F", "$nome=@`"$($a.FullName)`"")
  if ($videos -contains $a.Extension.ToLower()) {
    $item = @{ file = $nome; type = "clip" }
    if ($SomDosClipes) { $item.keepAudio = $true }
    $itens += $item
  } else {
    $itens += @{ file = $nome; type = "photo" }
  }
}

$opcoes = @{ preset = $Preset; platform = $Plataforma; items = $itens }
if ($Audio) {
  $campos += @("-F", "musica=@`"$((Resolve-Path $Audio).Path)`"")
  $trecho = @{ file = "musica"; start = $Inicio }
  if ($Duracao -gt 0) { $trecho.duration = $Duracao }
  $opcoes.audio = $trecho
} elseif ($MusicaId -or $Clima) {
  $trecho = @{ start = $Inicio }
  if ($MusicaId) { $trecho.libraryId = $MusicaId } else { $trecho.mood = $Clima }
  if ($Duracao -gt 0) { $trecho.duration = $Duracao }
  $opcoes.audio = $trecho
} else {
  $opcoes.timing = @{ mode = "fixed"; total = $(if ($Duracao -gt 0) { $Duracao } else { 15 }) }
}
$logos = @()
if ($Logo) { $campos += @("-F", "logo=@`"$((Resolve-Path $Logo).Path)`""); $logos += @{ role = "brand"; file = "logo" } }
if ($Parceiro) { $campos += @("-F", "parceiro=@`"$((Resolve-Path $Parceiro).Path)`""); $logos += @{ role = "partner"; file = "parceiro" } }
if ($logos.Count -gt 0) { $opcoes.logos = $logos }
if ($Titulo) { $opcoes.title = $Titulo }

# O JSON vai por arquivo temporário para não sofrer com aspas na linha de comando.
$json = $opcoes | ConvertTo-Json -Depth 6 -Compress
$tmp = New-TemporaryFile
[IO.File]::WriteAllText($tmp.FullName, $json, (New-Object Text.UTF8Encoding $false))

Write-Host "Enviando $($arquivos.Count) item(ns)..."
$resposta = & curl.exe -sS -X POST "$Url/v1/videos" -H "Authorization: Bearer $Chave" `
  -F "options=<$($tmp.FullName);type=application/json" @campos
Remove-Item $tmp.FullName
$r = $resposta | ConvertFrom-Json
if ($r.error) { throw "Erro $($r.error.code): $($r.error.message)" }
Write-Host "Pedido $($r.id) na fila (duração prevista: $($r.estimatedDuration) s)"
if ($r.audioTrack) { Write-Host "  música: $($r.audioTrack.name) ($($r.audioTrack.id))" }
foreach ($w in $r.warnings) { Write-Host "  aviso: $w" -ForegroundColor Yellow }

do {
  Start-Sleep -Seconds 3
  $s = & curl.exe -sS "$Url/v1/videos/$($r.id)" -H "Authorization: Bearer $Chave" | ConvertFrom-Json
  Write-Host ("  {0}: {1}%" -f $s.status, $s.progress)
} while ($s.status -eq "queued" -or $s.status -eq "processing")

if ($s.status -ne "done") { throw "Falhou: $($s.error.code) - $($s.error.message)" }
& curl.exe -sS -o $Saida $s.downloadUrl -H "Authorization: Bearer $Chave"
Write-Host "Vídeo salvo em $Saida (expira em $($s.expiresAt))" -ForegroundColor Green
