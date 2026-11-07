param(
  [ValidateSet('start', 'stop', 'status', 'restart', 'open')]
  [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root '.rab'
$StateFile = Join-Path $RuntimeDir 'processes.json'
$GatewayLog = Join-Path $RuntimeDir 'gateway.log'
$AgentLog = Join-Path $RuntimeDir 'agent.log'
$GatewayErrorLog = Join-Path $RuntimeDir 'gateway-error.log'
$AgentErrorLog = Join-Path $RuntimeDir 'agent-error.log'

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return @() }
  try { return @(Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json) }
  catch { return @() }
}

function Save-State([object[]]$Items) {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $Items | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Get-TrackedProcess([object]$Item) {
  try {
    $process = Get-Process -Id ([int]$Item.pid) -ErrorAction Stop
    $started = $process.StartTime.ToUniversalTime().Ticks
    if ($started -ne [long]$Item.start_ticks) { return $null }
    return $process
  } catch { return $null }
}

function Stop-Tracked {
  $state = Read-State
  foreach ($item in $state) {
    $process = Get-TrackedProcess $item
    if ($null -ne $process) {
      Write-Host ("Stopping {0} (PID {1})" -f $item.name, $item.pid)
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force }
}

function Start-Rab {
  $existing = Read-State | Where-Object { $null -ne (Get-TrackedProcess $_) }
  if (@($existing).Count -gt 0) {
    Write-Host 'Remote Agent Bridge is already running. Use scripts/rab.ps1 status to inspect it.'
    return
  }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1
    if ($health.ok) {
      Write-Host 'Remote Agent Bridge is already running on port 8787.'
      Write-Host 'Setup: http://127.0.0.1:8787/setup'
      return
    }
  } catch { }

  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  Write-Host 'Building Gateway and Agent...'
  Push-Location $Root
  try {
    $localTsc = Join-Path $Root 'node_modules\.bin\tsc.cmd'
    if (Test-Path -LiteralPath $localTsc) {
      & $localTsc --build --pretty false
    } elseif (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
      & pnpm.cmd exec tsc --build --pretty false
    } elseif (Get-Command corepack.exe -ErrorAction SilentlyContinue) {
      & corepack.exe pnpm exec tsc --build --pretty false
    } else {
      throw 'TypeScript is unavailable. Install Node.js, or run npm install in the project folder.'
    }
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
  } finally { Pop-Location }

  if (Test-Path -LiteralPath $GatewayLog) { Clear-Content -LiteralPath $GatewayLog }
  if (Test-Path -LiteralPath $AgentLog) { Clear-Content -LiteralPath $AgentLog }
  if (Test-Path -LiteralPath $GatewayErrorLog) { Clear-Content -LiteralPath $GatewayErrorLog }
  if (Test-Path -LiteralPath $AgentErrorLog) { Clear-Content -LiteralPath $AgentErrorLog }

  # Windows PowerShell can inherit both PATH and Path when launched from CMD.
  # Start-Process treats those as duplicate environment keys, so normalize it.
  $pathValue = $env:Path
  Remove-Item Env:PATH -ErrorAction SilentlyContinue
  $env:Path = $pathValue
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $gateway = Start-Process -FilePath $node -ArgumentList 'apps/gateway/dist/index.js' -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $GatewayLog -RedirectStandardError $GatewayErrorLog -PassThru
  Start-Sleep -Milliseconds 700
  $agent = Start-Process -FilePath $node -ArgumentList 'services/agent/dist/index.js' -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $AgentLog -RedirectStandardError $AgentErrorLog -PassThru

  Save-State @(
    [pscustomobject]@{ name = 'gateway'; pid = $gateway.Id; start_ticks = $gateway.StartTime.ToUniversalTime().Ticks },
    [pscustomobject]@{ name = 'agent'; pid = $agent.Id; start_ticks = $agent.StartTime.ToUniversalTime().Ticks }
  )
  Write-Host 'Remote Agent Bridge started in background.'
  Write-Host 'Gateway: http://127.0.0.1:8787'
  Write-Host 'Setup: npm run setup  (or: powershell -File scripts/rab.ps1 open)'
  Write-Host '       it starts the service if needed and passes the setup token along'
  Write-Host 'Logs: .rab/gateway.log, .rab/gateway-error.log, .rab/agent.log and .rab/agent-error.log'
}

function Show-Status {
  $state = Read-State
  if (@($state).Count -eq 0) { Write-Host 'Remote Agent Bridge is stopped.'; return }
  foreach ($item in $state) {
    $process = Get-TrackedProcess $item
    $stateText = if ($null -ne $process) { 'running' } else { 'stopped' }
    Write-Host ("{0}: {1} (PID {2})" -f $item.name, $stateText, $item.pid)
  }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2
    Write-Host ("Gateway: online={0}, agentOnline={1}" -f $health.ok, $health.agentOnline)
  } catch { Write-Host 'Gateway: unreachable' }
}

function Open-Setup {
  # The setup page is served by the Gateway itself, so opening it while the
  # service is stopped can only ever fail: nothing is listening on the port and
  # the setup token does not exist yet either. Start it first.
  $health = $null
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 } catch { }
  if (-not $health) {
    Write-Host 'Service is not running, starting it first...'
    Start-Rab
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not $health) {
      Start-Sleep -Milliseconds 500
      try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 } catch { }
    }
    if (-not $health) {
      Write-Host 'Service did not come up within 30s. Run "npm run status" to see why.'
      return
    }
  }
  # The privileged setup API requires the setup token, because a tunnel forwards
  # to 127.0.0.1 and would otherwise look local. The token lives in the data
  # directory, so only this machine can read it.
  $tokenFile = Join-Path $RuntimeDir 'setup-token'
  $url = 'http://127.0.0.1:8787/setup'
  if (Test-Path -LiteralPath $tokenFile) {
    $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    if ($token) { $url = "$url`?token=$token" }
  } else {
    Write-Host "No setup token yet ($tokenFile). Run this again once the service has started."
  }
  try {
    # ShellExecute (Start-Process' default when nothing is redirected) hands the
    # URL to the running shell, which is what makes it open in the normal
    # browser. Do NOT route this through explorer.exe: when this script is
    # spawned with inherited standard handles, explorer.exe dies on start with
    # 0xc0000142 (STATUS_DLL_INIT_FAILED).
    Start-Process $url -ErrorAction Stop | Out-Null
    Write-Host 'Opened setup page: http://127.0.0.1:8787/setup'
  } catch {
    Write-Host 'Service is running. Open this address manually:'
    Write-Host $url
  }
}

# --- tray control -----------------------------------------------------------
# A compiled tray helper lived here. It is gone: on this machine the shell never
# registered the icon (Shell_NotifyIcon failed silently - HKCU\Control Panel\
# NotifyIconSettings had no entry for it), and a freshly compiled, unsigned exe
# in .rab/ trips Windows' "无法验证发布者" warning every time it runs. The
# commands below are the whole control surface now: no binary, nothing to sign,
# nothing to trust.

switch ($Command) {
  'start' { Start-Rab }
  'restart' { Stop-Tracked; Start-Sleep -Milliseconds 500; Start-Rab }
  'open' { Open-Setup }
  'stop' { Stop-Tracked; Write-Host 'Remote Agent Bridge stopped.' }
  'status' { Show-Status }
}
