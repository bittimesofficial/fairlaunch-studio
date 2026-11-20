param()
$ErrorActionPreference = 'Stop'
$endpoint = 'https://sepolia-rpc.giwa.io'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $root 'fixtures\onchain'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$path = Join-Path $outDir "rpc-$stamp.json"
$calls = @(
  @{ method = 'eth_chainId'; params = @() },
  @{ method = 'eth_blockNumber'; params = @() },
  @{ method = 'eth_getCode'; params = @('0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA', 'latest') },
  @{ method = 'eth_getCode'; params = @('0x6d043014972b87406C4757a5f2d655A24e0b0aF9', 'latest') },
  @{ method = 'eth_getCode'; params = @('0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451', 'latest') }
)
$results = @()
foreach ($call in $calls) {
  $at = (Get-Date).ToUniversalTime().ToString('o')
  $body = @{ jsonrpc = '2.0'; id = $results.Count + 1; method = $call.method; params = $call.params } | ConvertTo-Json -Depth 5 -Compress
  try {
    $response = Invoke-WebRequest -Uri $endpoint -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 12
    $json = $response.Content | ConvertFrom-Json
    $results += @{ utc = $at; method = $call.method; params = $call.params; httpStatus = [int]$response.StatusCode; result = $json.result; rpcError = $json.error }
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $results += @{ utc = $at; method = $call.method; params = $call.params; httpStatus = $status; error = $_.Exception.Message }
  }
}
$chain = $results[0].result
$block = $results[1].result
$ok = ($chain -eq '0x164ce') -and ($block -match '^0x[0-9a-f]+$') -and (($results | Where-Object { $_.method -eq 'eth_getCode' -and (!$_.result -or $_.result -eq '0x') }).Count -eq 0)
@{ utc = (Get-Date).ToUniversalTime().ToString('o'); endpoint = $endpoint; expectedChainId = 91342; status = $(if ($ok) { 'PASS' } else { 'BLOCKED' }); calls = $results } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding utf8
Write-Output "Evidence: $path"
if ($ok) { exit 0 } else { exit 2 }
