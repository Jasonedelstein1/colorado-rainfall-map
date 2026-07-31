# Launch the Colorado Rainfall Forage Map: start serve.py if not already running, open browser.
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8642

$up = $false
try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $port)
    $up = $c.Connected
    $c.Close()
} catch {}

if (-not $up) {
    Start-Process -FilePath "python" -ArgumentList "serve.py" -WorkingDirectory $proj -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
Start-Process "http://localhost:$port"
