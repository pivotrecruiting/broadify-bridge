param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath,
  [string]$OutputDirectory = (Join-Path $env:TEMP "broadify-display-helper-diagnostics")
)

$ErrorActionPreference = "Stop"

$resolvedHelperPath = (Resolve-Path -LiteralPath $HelperPath).Path
$helperDirectory = Split-Path -Parent $resolvedHelperPath
$resourceRoot = (Resolve-Path (Join-Path $helperDirectory "..\..")).Path
$artifactPaths = @(
  $resolvedHelperPath,
  (Join-Path $helperDirectory "SDL2.dll"),
  (Join-Path $resourceRoot "native\meeting-helper\onnxruntime.dll")
)

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$artifactReport = foreach ($artifactPath in $artifactPaths) {
  if (-not (Test-Path -LiteralPath $artifactPath)) {
    [PSCustomObject]@{
      path = $artifactPath
      exists = $false
    }
    continue
  }

  $file = Get-Item -LiteralPath $artifactPath
  $signature = Get-AuthenticodeSignature -LiteralPath $artifactPath
  $hash = Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256
  [PSCustomObject]@{
    path = $file.FullName
    exists = $true
    size_bytes = $file.Length
    sha256 = $hash.Hash
    signature_status = [string]$signature.Status
    signature_status_message = $signature.StatusMessage
    signer_subject = $signature.SignerCertificate.Subject
    signer_thumbprint = $signature.SignerCertificate.Thumbprint
  }
}
$artifactReport |
  ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath (Join-Path $OutputDirectory "artifacts.json") -Encoding utf8

function Invoke-DisplayHelperDiagnostic {
  param(
    [string[]]$Arguments,
    [string]$OutputName
  )

  try {
    $lines = @(& $resolvedHelperPath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } catch {
    $lines = @($_.Exception.Message)
    $exitCode = $null
  }
  [PSCustomObject]@{
    arguments = $Arguments
    exit_code = $exitCode
    output = ($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  } |
    ConvertTo-Json -Depth 3 |
    Set-Content -LiteralPath (Join-Path $OutputDirectory $OutputName) -Encoding utf8
}

Invoke-DisplayHelperDiagnostic -Arguments @("--self-test") -OutputName "self-test.json"
Invoke-DisplayHelperDiagnostic -Arguments @("--list-displays") -OutputName "display-list.json"

$eventLogQueries = @(
  [PSCustomObject]@{
    name = "code-integrity-events.json"
    log = "Microsoft-Windows-CodeIntegrity/Operational"
  },
  [PSCustomObject]@{
    name = "defender-events.json"
    log = "Microsoft-Windows-Windows Defender/Operational"
  }
)
$startTime = (Get-Date).AddHours(-4)

foreach ($query in $eventLogQueries) {
  try {
    $events = Get-WinEvent -FilterHashtable @{
      LogName = $query.log
      StartTime = $startTime
    } -ErrorAction Stop |
      Where-Object {
        $_.Message -match "display-helper|SDL2\.dll|onnxruntime\.dll|Broadify"
      } |
      Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message
    @($events) |
      ConvertTo-Json -Depth 4 |
      Set-Content -LiteralPath (Join-Path $OutputDirectory $query.name) -Encoding utf8
  } catch {
    [PSCustomObject]@{ error = $_.Exception.Message } |
      ConvertTo-Json |
      Set-Content -LiteralPath (Join-Path $OutputDirectory $query.name) -Encoding utf8
  }
}

Write-Host "Windows display-helper diagnostics written to $OutputDirectory"
