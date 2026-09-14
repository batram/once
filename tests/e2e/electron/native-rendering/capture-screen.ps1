param([Parameter(Mandatory)][string]$ReportPath)
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RenderingScreen {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
$rect = $report.stages[-1].geometry.bounds
if (-not $rect) { throw 'No measured content rectangle to capture' }
$point = [RenderingScreen+Point]::new()
$point.X = [int]$rect.x + 20
$point.Y = [int]$rect.y + 80
$hitWindow = [RenderingScreen]::WindowFromPoint($point)
$hitProcess = [uint32]0
[void][RenderingScreen]::GetWindowThreadProcessId($hitWindow, [ref]$hitProcess)
@{ processId = $hitProcess; window = $hitWindow.ToInt64() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path $ReportPath) 'screen-owner.json')
$bitmap = [Drawing.Bitmap]::new([int]$rect.width, [int]$rect.height)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen([int]$rect.x, [int]$rect.y, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path (Split-Path $ReportPath) 'screen.png'), [Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
