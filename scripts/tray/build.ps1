<#
  Compiles the tray control with the csc.exe that ships with .NET Framework 4.

  No toolchain, no NuGet, no committed binary: the executable is produced into
  .rab/ (which is gitignored) on first use, and rebuilt only when tray.cs is
  newer. Emits the path of the resulting executable.
#>
param(
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'tray.cs'
$dataDir = Join-Path $Root '.rab'
$output = Join-Path $dataDir 'tray.exe'

if ((Test-Path -LiteralPath $output) -and ((Get-Item -LiteralPath $output).LastWriteTimeUtc -ge (Get-Item -LiteralPath $source).LastWriteTimeUtc)) {
  Write-Output $output
  return
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$compiler = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $compiler) {
  throw 'csc.exe (.NET Framework 4) was not found. The tray app needs it to compile once; Windows 10 and 11 always ship it.'
}

& $compiler /nologo /target:winexe /codepage:65001 /out:$output /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) { throw "compiling the tray app failed (csc exit $LASTEXITCODE)" }
if (-not (Test-Path -LiteralPath $output)) { throw 'csc reported success but produced no executable' }

Write-Output $output
