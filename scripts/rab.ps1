param(
  [ValidateSet('start', 'stop', 'status', 'restart', 'relaunch', 'open')]
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
    Write-Host 'Remote Agent Bridge is already running. Use setup.cmd or scripts/rab.ps1 status to inspect it.'
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
  Write-Host 'Setup: http://127.0.0.1:8787/setup (run setup.cmd to open)'
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
  # The privileged setup API requires the setup token, because a tunnel forwards
  # to 127.0.0.1 and would otherwise look local. The token lives in the data
  # directory, so only this machine can read it.
  $tokenFile = Join-Path $RuntimeDir 'setup-token'
  $url = 'http://127.0.0.1:8787/setup'
  if (Test-Path -LiteralPath $tokenFile) {
    $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    if ($token) { $url = "$url`?token=$token" }
  } else {
    Write-Host "No setup token yet ($tokenFile). Start the service once, then run setup again."
  }
  try {
    Start-Process $url -ErrorAction Stop | Out-Null
    Write-Host 'Opened setup page: http://127.0.0.1:8787/setup'
  } catch {
    Write-Host 'Service is running. Open this address manually:'
    Write-Host $url
  }
}

switch ($Command) {
  'start' { Start-Rab }
  'restart' { Stop-Tracked; Start-Sleep -Milliseconds 500; Start-Rab }
  'relaunch' { Stop-Tracked; Start-Sleep -Milliseconds 500; Start-Rab }
  'open' { Open-Setup }
  'stop' { Stop-Tracked; Write-Host 'Remote Agent Bridge stopped.' }
  'status' { Show-Status }
}
