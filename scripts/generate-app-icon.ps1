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

function Draw-FileCard {
    param(
        [System.Drawing.Graphics]$Graphics,
        [hashtable]$Palette,
        [float]$CanvasSize,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [System.Drawing.Color]$FillColor,
        [System.Drawing.Color]$LineColor,
        [bool]$Primary = $false
    )

    $shadowOffset = [Math]::Max(2.0, $CanvasSize * 0.018)
    $shadowRect = [System.Drawing.RectangleF]::new(
        [float]($X + $shadowOffset),
        [float]($Y + $shadowOffset),
        [float]$Width,
        [float]$Height
    )
    $shadowPath = New-RoundedRectanglePath -Rect $shadowRect -Radius ([Math]::Max(8.0, $CanvasSize * 0.04))
    $Graphics.FillPath((New-Object System.Drawing.SolidBrush($Palette.Shadow)), $shadowPath)
    $shadowPath.Dispose()

    $radius = [Math]::Max(8.0, $CanvasSize * 0.04)
    $cardRect = [System.Drawing.RectangleF]::new([float]$X, [float]$Y, [float]$Width, [float]$Height)
    $path = New-RoundedRectanglePath -Rect $cardRect -Radius $radius
    $Graphics.FillPath((New-Object System.Drawing.SolidBrush($FillColor)), $path)
    $Graphics.DrawPath((New-Object System.Drawing.Pen($Palette.CardBorder, [Math]::Max(2.0, $CanvasSize * 0.01))), $path)

    $foldSize = $Width * 0.25
    $foldPoints = New-Object 'System.Drawing.PointF[]' 3
    $foldPoints[0] = [System.Drawing.PointF]::new([float]($X + $Width - $foldSize), [float]$Y)
    $foldPoints[1] = [System.Drawing.PointF]::new([float]($X + $Width), [float]$Y)
    $foldPoints[2] = [System.Drawing.PointF]::new([float]($X + $Width), [float]($Y + $foldSize))
    $foldColor = if ($Primary) { $Palette.PrimaryFold } else { $Palette.SideFold }
    $Graphics.FillPolygon((New-Object System.Drawing.SolidBrush($foldColor)), $foldPoints)

    $lineWidth = [Math]::Max(3.0, $CanvasSize * 0.014)
    $linePen = New-Object System.Drawing.Pen($LineColor, $lineWidth)
    $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $innerPaddingX = $Width * 0.18
    $innerPaddingTop = $Height * 0.34
    $lineGap = $Height * 0.15
    $lineLengths = @(($Width * 0.54), ($Width * 0.44), ($Width * 0.50))
    $lineCount = if ($CanvasSize -lt 32) { 2 } else { 3 }

    0..($lineCount - 1) | ForEach-Object {
        $lineY = $Y + $innerPaddingTop + ($_ * $lineGap)
        $Graphics.DrawLine(
            $linePen,
            $X + $innerPaddingX,
            $lineY,
            $X + $innerPaddingX + $lineLengths[$_],
            $lineY
        )
    }

    $linePen.Dispose()
    $path.Dispose()
}

function Draw-CompareMark {
    param(
        [System.Drawing.Graphics]$Graphics,
        [hashtable]$Palette,
        [float]$CanvasSize
    )

    if ($CanvasSize -lt 32) {
        return
    }

    $markRect = [System.Drawing.RectangleF]::new(
        [float]($CanvasSize * 0.33),
        [float]($CanvasSize * 0.755),
        [float]($CanvasSize * 0.34),
        [float]($CanvasSize * 0.09)
    )
    $markPath = New-RoundedRectanglePath -Rect $markRect -Radius ($CanvasSize * 0.045)
    $Graphics.FillPath((New-Object System.Drawing.SolidBrush($Palette.MarkBackground)), $markPath)

    $leftX = $CanvasSize * 0.42
    $centerX = $CanvasSize * 0.5
    $rightX = $CanvasSize * 0.58
    $dotY = $CanvasSize * 0.80
    $dotRadius = [Math]::Max(4.0, $CanvasSize * 0.018)

    $connectorPen = New-Object System.Drawing.Pen($Palette.MarkConnector, [Math]::Max(2.0, $CanvasSize * 0.008))
    $connectorPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $connectorPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $Graphics.DrawLine($connectorPen, $leftX + $dotRadius, $dotY, $centerX - $dotRadius, $dotY)
    $Graphics.DrawLine($connectorPen, $centerX + $dotRadius, $dotY, $rightX - $dotRadius, $dotY)

    $sideDotBrush = New-Object System.Drawing.SolidBrush($Palette.MarkSideDot)
    $centerDotBrush = New-Object System.Drawing.SolidBrush($Palette.MarkCenterDot)
    foreach ($dotX in @($leftX, $rightX)) {
        $Graphics.FillEllipse($sideDotBrush, $dotX - $dotRadius, $dotY - $dotRadius, $dotRadius * 2, $dotRadius * 2)
    }
    $Graphics.FillEllipse($centerDotBrush, $centerX - ($dotRadius * 1.15), $dotY - ($dotRadius * 1.15), $dotRadius * 2.3, $dotRadius * 2.3)

    $connectorPen.Dispose()
    $sideDotBrush.Dispose()
    $centerDotBrush.Dispose()
    $markPath.Dispose()
}

function New-AppIconBitmap {
    param([int]$Size)

    $palette = @{
        Background = [System.Drawing.ColorTranslator]::FromHtml('#0B1220')
        Border = [System.Drawing.ColorTranslator]::FromHtml('#172033')
        CardBorder = [System.Drawing.ColorTranslator]::FromHtml('#111827')
        Shadow = [System.Drawing.Color]::FromArgb(70, 0, 0, 0)
        SideCard = [System.Drawing.ColorTranslator]::FromHtml('#E8EEF6')
        PrimaryCard = [System.Drawing.ColorTranslator]::FromHtml('#14B8A6')
        SideFold = [System.Drawing.ColorTranslator]::FromHtml('#CBD5E1')
        PrimaryFold = [System.Drawing.ColorTranslator]::FromHtml('#0F766E')
        LightLines = [System.Drawing.ColorTranslator]::FromHtml('#ECFEFF')
        DarkLines = [System.Drawing.ColorTranslator]::FromHtml('#111827')
        MarkBackground = [System.Drawing.ColorTranslator]::FromHtml('#111C2F')
        MarkConnector = [System.Drawing.ColorTranslator]::FromHtml('#475569')
        MarkSideDot = [System.Drawing.ColorTranslator]::FromHtml('#94A3B8')
        MarkCenterDot = [System.Drawing.ColorTranslator]::FromHtml('#22C55E')
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

    $cardWidth = $Size * 0.205
    $sideHeight = $Size * 0.41
    $middleHeight = $Size * 0.49
    $sideY = $Size * 0.31
    $middleY = $Size * 0.245

    Draw-FileCard -Graphics $graphics -Palette $palette -CanvasSize $Size -X ($Size * 0.19) -Y $sideY -Width $cardWidth -Height $sideHeight -FillColor $palette.SideCard -LineColor $palette.DarkLines
    Draw-FileCard -Graphics $graphics -Palette $palette -CanvasSize $Size -X ($Size * 0.605) -Y $sideY -Width $cardWidth -Height $sideHeight -FillColor $palette.SideCard -LineColor $palette.DarkLines
    Draw-FileCard -Graphics $graphics -Palette $palette -CanvasSize $Size -X ($Size * 0.3975) -Y $middleY -Width $cardWidth -Height $middleHeight -FillColor $palette.PrimaryCard -LineColor $palette.LightLines -Primary $true

    Draw-CompareMark -Graphics $graphics -Palette $palette -CanvasSize $Size

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
        [hashtable[]]$Images
    )

    $fileStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    $writer = New-Object System.IO.BinaryWriter($fileStream)

    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$Images.Count)

    $imageOffset = 6 + ($Images.Count * 16)
    foreach ($image in $Images) {
        $size = [int]$image.Size
        $bytes = [byte[]]$image.Bytes
        $icoSizeByte = if ($size -ge 256) { 0 } else { $size }

        $writer.Write([byte]$icoSizeByte)
        $writer.Write([byte]$icoSizeByte)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$bytes.Length)
        $writer.Write([UInt32]$imageOffset)

        $imageOffset += $bytes.Length
    }

    foreach ($image in $Images) {
        $bytes = [byte[]]$image.Bytes
        $fileStream.Write($bytes, 0, $bytes.Length)
    }

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

$icoImages = @(16, 24, 32, 48, 64, 128, 256) | ForEach-Object {
    $icoBitmap = New-AppIconBitmap -Size $_
    $icoBytes = Get-PngBytes -Bitmap $icoBitmap
    $icoBitmap.Dispose()

    @{
        Size = $_
        Bytes = $icoBytes
    }
}

Save-Ico -Path $icoPath -Images $icoImages
Write-Host "Generated $pngPath"
Write-Host "Generated $icoPath"
