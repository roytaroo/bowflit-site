# AI Society: Windows 用の全自動インストーラー
# PowerShell に次の1行を貼り付けて実行 (日本語が文字化けしないよう UTF-8 で読み込む):
#   iex ([Text.Encoding]::UTF8.GetString((iwr -UseBasicParsing 'https://raw.githubusercontent.com/roytaroo/bowflit-site/claude/minecraft-9-ai-society-fdttk2/ai-society/scripts/windows/bootstrap.ps1').RawContentStream.ToArray()))
#
# やること: winget で Git / Node.js / Java 21 / Ollama / Python / VOICEVOX を入れる
#           → コードを %USERPROFILE%\ai-minecraft にダウンロード → setup.bat を実行
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'https://github.com/roytaroo/bowflit-site.git'
$Branch = 'claude/minecraft-9-ai-society-fdttk2'
$Dest = Join-Path $env:USERPROFILE 'ai-minecraft'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Install-Winget($id, $cmd) {
  if ($cmd -and (Has $cmd)) { Write-Host "  OK  $id (インストール済み)"; return }
  Write-Host "  ... $id をインストール中 (確認画面が出たら「はい」)"
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
}

if (-not (Has 'winget')) {
  Write-Host 'winget が見つかりません。Microsoft Store で「アプリ インストーラー」を入れてから、もう一度実行してください。' -ForegroundColor Red
  return
}

Step '1/3 必要なソフトをインストール'
Install-Winget 'Git.Git' 'git'
Install-Winget 'OpenJS.NodeJS.LTS' 'node'
Install-Winget 'EclipseAdoptium.Temurin.21.JDK' 'java'
Install-Winget 'Ollama.Ollama' 'ollama'
Install-Winget 'Python.Python.3.12' 'py'
$vv = Join-Path $env:LOCALAPPDATA 'Programs\VOICEVOX\VOICEVOX.exe'
if (Test-Path $vv) { Write-Host '  OK  VOICEVOX (インストール済み)' }
else {
  Write-Host '  ... VOICEVOX を探しています'
  winget install --name VOICEVOX --silent --accept-package-agreements --accept-source-agreements | Out-Host
  if (-not (Test-Path $vv)) { Write-Host '  VOICEVOX は自動で入れられませんでした。https://voicevox.hiroshiba.jp/ から入れると声で話します (後からでOK)' -ForegroundColor Yellow }
}
Refresh-Path

Step '2/3 コードをダウンロード'
if (-not (Has 'git')) { Write-Host 'git が使えません。PowerShell を開き直してもう一度実行してください。' -ForegroundColor Red; return }
if (Test-Path (Join-Path $Dest '.git')) {
  git -C $Dest fetch origin $Branch
  git -C $Dest checkout $Branch
  git -C $Dest pull --ff-only origin $Branch
} else {
  git clone -b $Branch --depth 1 $Repo $Dest
}
$App = Join-Path $Dest 'ai-society'
if (-not (Test-Path $App)) { Write-Host 'ダウンロードに失敗しました。' -ForegroundColor Red; return }

Step '3/3 セットアップ'
if (-not (Has 'node')) { Write-Host 'Node.js が使えません。PowerShell を開き直して、もう一度この1行を実行してください。' -ForegroundColor Red; return }
Push-Location $App
& cmd.exe /c setup.bat
Pop-Location

# デスクトップに起動用ショートカット
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Society 起動.lnk'))
  $lnk.TargetPath = Join-Path $App 'start.bat'
  $lnk.WorkingDirectory = $App
  $lnk.Save()
  Write-Host "`nデスクトップに「AI Society 起動」を作りました。ダブルクリックで全部起動します。" -ForegroundColor Green
} catch { Write-Host "起動は $App\start.bat をダブルクリック" }
