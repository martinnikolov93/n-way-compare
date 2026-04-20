$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
    param(
        [System.Drawing.RectangleF]$Rect,
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath

    $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()

    return $path
}

function Draw-ColumnCard {
    param(
        [System.Drawing.Graphics]$Graphics,
        [hashtable]$Palette,
        [float]$CanvasSize,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [System.Drawing.Color]$FillColor,
        [System.Drawing.Color]$LineColor
    )

    $radius = [Math]::Max(8.0, $CanvasSize * 0.035)
    $cardRect = [System.Drawing.RectangleF]::new([float]$X, [float]$Y, [float]$Width, [float]$Height)
    $path = New-RoundedRectanglePath -Rect $cardRect -Radius $radius
    $Graphics.FillPath((New-Object System.Drawing.SolidBrush($FillColor)), $path)
    $Graphics.DrawPath((New-Object System.Drawing.Pen($Palette.Border, [Math]::Max(2.0, $CanvasSize * 0.012))), $path)

    $lineWidth = [Math]::Max(4.0, $CanvasSize * 0.018)
    $linePen = New-Object System.Drawing.Pen($LineColor, $lineWidth)
    $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $innerPaddingX = $Width * 0.2
    $innerPaddingTop = $Height * 0.24
    $lineGap = $Height * 0.16
    $lineLength = $Width * 0.5

    0..2 | ForEach-Object {
        $lineY = $Y + $innerPaddingTop + ($_ * $lineGap)
        $Graphics.DrawLine(
            $linePen,
            $X + $innerPaddingX,
            $lineY,
            $X + $innerPaddingX + $lineLength,
            $lineY
        )
    }
}

function Draw-CompareArrows {
    param(
        [System.Drawing.Graphics]$Graphics,
        [hashtable]$Palette,
        [float]$CanvasSize
    )

    $penWidth = [Math]::Max(10.0, $CanvasSize * 0.022)
    $pen = New-Object System.Drawing.Pen($Palette.Arrow, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $midY = $CanvasSize * 0.71
    $leftX = $CanvasSize * 0.26
    $rightX = $CanvasSize * 0.74
    $centerX = $CanvasSize * 0.5
    $offsetY = $CanvasSize * 0.045
    $headSize = $CanvasSize * 0.04

    $Graphics.DrawLine($pen, $leftX, $midY - $offsetY, $rightX - $headSize, $midY - $offsetY)
    $Graphics.DrawLine($pen, $rightX - $headSize, $midY - $offsetY, $rightX - ($headSize * 0.4), $midY - ($offsetY + $headSize * 0.55))
    $Graphics.DrawLine($pen, $rightX - $headSize, $midY - $offsetY, $rightX - ($headSize * 0.4), $midY - ($offsetY - $headSize * 0.55))

    $Graphics.DrawLine($pen, $rightX, $midY + $offsetY, $leftX + $headSize, $midY + $offsetY)
    $Graphics.DrawLine($pen, $leftX + $headSize, $midY + $offsetY, $leftX + ($headSize * 0.4), $midY + ($offsetY - $headSize * 0.55))
    $Graphics.DrawLine($pen, $leftX + $headSize, $midY + $offsetY, $leftX + ($headSize * 0.4), $midY + ($offsetY + $headSize * 0.55))

    $dotRadius = $CanvasSize * 0.026
    $Graphics.FillEllipse(
        (New-Object System.Drawing.SolidBrush($Palette.ArrowAccent)),
        $centerX - $dotRadius,
        $midY - $dotRadius,
        $dotRadius * 2,
        $dotRadius * 2
    )
}

function New-AppIconBitmap {
    param([int]$Size)

    $palette = @{
        Background = [System.Drawing.ColorTranslator]::FromHtml('#0F172A')
        Border = [System.Drawing.ColorTranslator]::FromHtml('#0B1220')
        LeftCard = [System.Drawing.ColorTranslator]::FromHtml('#CBD5E1')
        MiddleCard = [System.Drawing.ColorTranslator]::FromHtml('#14B8A6')
        RightCard = [System.Drawing.ColorTranslator]::FromHtml('#E2E8F0')
        LightLines = [System.Drawing.ColorTranslator]::FromHtml('#F8FAFC')
        DarkLines = [System.Drawing.ColorTranslator]::FromHtml('#134E4A')
        Arrow = [System.Drawing.ColorTranslator]::FromHtml('#F8FAFC')
        ArrowAccent = [System.Drawing.ColorTranslator]::FromHtml('#22C55E')
    }

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $badgeRect = [System.Drawing.RectangleF]::new(
        [float]($Size * 0.08),
        [float]($Size * 0.08),
        [float]($Size * 0.84),
        [float]($Size * 0.84)
    )
    $badgePath = New-RoundedRectanglePath -Rect $badgeRect -Radius ($Size * 0.18)
    $graphics.FillPath((New-Object System.Drawing.SolidBrush($palette.Background)), $badgePath)
    $graphics.DrawPath((New-Object System.Drawing.Pen($palette.Border, [Math]::Max(4.0, $Size * 0.018))), $badgePath)

    $cardWidth = $Size * 0.165
    $sideHeight = $Size * 0.36
    $middleHeight = $Size * 0.42
    $topY = $Size * 0.24

    Draw-ColumnCard -Graphics $graphics -Palette $palette -CanvasSize $Size -X ($Size * 0.185) -Y ($topY + $Size * 0.03) -Width $cardWidth -Height $sideHeight -FillColor $palette.LeftCard -LineColor $palette.Background
    Draw-ColumnCard -Graphics $graphics -Palette $palette -CanvasSize $Size -X ($Size * 0.4175) -Y $topY -Width $cardWidth -Height $middleHeight -FillColor $palette.MiddleCard -LineColor $palette.LightLines
    Draw-ColumnCard -Graphics $graphics -Palette $palette -CanvasSize $Size -X ($Size * 0.65) -Y ($topY + $Size * 0.03) -Width $cardWidth -Height $sideHeight -FillColor $palette.RightCard -LineColor $palette.Background

    Draw-CompareArrows -Graphics $graphics -Palette $palette -CanvasSize $Size

    $graphics.Dispose()
    return $bitmap
}

function Save-Png {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Get-PngBytes {
    param([System.Drawing.Bitmap]$Bitmap)

    $stream = New-Object System.IO.MemoryStream
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stream.Dispose()
    return $bytes
}

function Save-Ico {
    param(
        [string]$Path,
        [byte[]]$PngBytes
    )

    $fileStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    $writer = New-Object System.IO.BinaryWriter($fileStream)

    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]1)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$PngBytes.Length)
    $writer.Write([UInt32]22)
    $fileStream.Write($PngBytes, 0, $PngBytes.Length)

    $writer.Dispose()
    $fileStream.Dispose()
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$assetsDir = Join-Path $projectRoot 'assets'

if (-not (Test-Path $assetsDir)) {
    New-Item -ItemType Directory -Path $assetsDir | Out-Null
}

$pngPath = Join-Path $assetsDir 'app-icon.png'
$icoPath = Join-Path $assetsDir 'app-icon.ico'

$masterBitmap = New-AppIconBitmap -Size 1024
Save-Png -Bitmap $masterBitmap -Path $pngPath
$masterBitmap.Dispose()

$icoBitmap = New-AppIconBitmap -Size 256
$icoBytes = Get-PngBytes -Bitmap $icoBitmap
$icoBitmap.Dispose()

Save-Ico -Path $icoPath -PngBytes $icoBytes
Write-Host "Generated $pngPath"
Write-Host "Generated $icoPath"
