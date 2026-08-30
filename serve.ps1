<#
.SYNOPSIS
    Serves this folder over HTTP so the game can be played, with no dependencies.

.DESCRIPTION
    Browsers refuse to load JavaScript modules over file://, so the game has to be
    served. This is a minimal static file server built on the .NET sockets that
    ship with Windows, so it needs no Python, no Node and no administrator rights.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\serve.ps1
#>

[CmdletBinding()]
param(
    [int]$Port = 8931,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$root = [System.IO.Path]::GetFullPath($root)

$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.md'   = 'text/markdown; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.txt'  = 'text/plain; charset=utf-8'
}

# Bind to the loopback address only: no firewall prompt, nothing exposed to the
# network, and no URL reservation needed (so no administrator rights either).
$address = [System.Net.IPAddress]::Loopback
$listener = New-Object System.Net.Sockets.TcpListener($address, $Port)

try {
    $listener.Start()
} catch {
    Write-Host ""
    Write-Host "Could not listen on port $Port." -ForegroundColor Red
    Write-Host "Something else is probably using it. Try another one, for example:" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 8080" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  BLACKSITE" -ForegroundColor Cyan
Write-Host "  serving $root"
Write-Host "  open $url" -ForegroundColor Green
Write-Host "  press Ctrl+C to stop"
Write-Host ""

if (-not $NoBrowser) {
    try { Start-Process $url | Out-Null } catch { }
}

function Send-Response {
    param($Stream, [int]$Status, [string]$Reason, [string]$ContentType, [byte[]]$Body)

    $header = "HTTP/1.1 $Status $Reason`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($Body.Length)`r`n" +
              "Cache-Control: no-cache, no-store`r`n" +
              "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 15000
            $stream = $client.GetStream()
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)

            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }
            # Drain the remaining request headers so the client is not left waiting.
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line -eq '') { break }
            }

            $parts = $requestLine.Split(' ')
            if ($parts.Count -lt 2) { continue }
            $method = $parts[0]
            $target = $parts[1]

            if ($method -ne 'GET' -and $method -ne 'HEAD') {
                Send-Response $stream 405 'Method Not Allowed' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Only GET is supported.'))
                continue
            }

            # Strip the query string and fragment, then decode percent escapes.
            $path = $target.Split('?')[0].Split('#')[0]
            $path = [System.Uri]::UnescapeDataString($path)
            if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
            $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)

            $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $relative))

            # Refuse anything that escapes the served folder.
            if (-not $candidate.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-Response $stream 403 'Forbidden' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
                Write-Host "  403  $path" -ForegroundColor Red
                continue
            }

            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes("Not found: $path"))
                Write-Host "  404  $path" -ForegroundColor Yellow
                continue
            }

            $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
            $contentType = $mimeTypes[$extension]
            if (-not $contentType) { $contentType = 'application/octet-stream' }

            $bytes = [System.IO.File]::ReadAllBytes($candidate)
            if ($method -eq 'HEAD') { $bytes = New-Object byte[] 0 }
            Send-Response $stream 200 'OK' $contentType $bytes
        } catch {
            # A browser closing a connection early is normal; keep serving.
        } finally {
            if ($client) { $client.Close() }
        }
    }
} finally {
    $listener.Stop()
    Write-Host ""
    Write-Host "  stopped." -ForegroundColor DarkGray
}
