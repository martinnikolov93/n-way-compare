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

    for ($lineIndex = 0; $lineIndex -lt $lineCount; $lineIndex++) {
        $lineY = $Y + $innerPaddingTop + ($lineIndex * $lineGap)
        $Graphics.DrawLine(
            $linePen,
            $X + $innerPaddingX,
            $lineY,
            $X + $innerPaddingX + $lineLengths[$lineIndex],
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

    if ($CanvasSize -lt 64) {
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

function Draw-SmallAppIcon {
    param(
        [System.Drawing.Graphics]$Graphics,
        [hashtable]$Palette,
        [int]$Size
    )

    $badgeRect = [System.Drawing.RectangleF]::new(
        [float]($Size * 0.08),
        [float]($Size * 0.08),
        [float]($Size * 0.84),
        [float]($Size * 0.84)
    )
    $badgePath = New-RoundedRectanglePath -Rect $badgeRect -Radius ($Size * 0.18)
    $Graphics.FillPath((New-Object System.Drawing.SolidBrush($Palette.Background)), $badgePath)

    $borderWidth = [Math]::Max(1.0, $Size * 0.045)
    $Graphics.DrawPath((New-Object System.Drawing.Pen($Palette.Border, $borderWidth)), $badgePath)

    $sideWidth = [Math]::Max(2.0, $Size * 0.17)
    $centerWidth = [Math]::Max(3.0, $Size * 0.2)
    $sideHeight = $Size * 0.44
    $centerHeight = $Size * 0.56
    $sideY = $Size * 0.32
    $centerY = $Size * 0.24
    $radius = [Math]::Max(1.5, $Size * 0.055)

    $cardSpecs = @(
        @{
            X = $Size * 0.25
            Y = $sideY
            Width = $sideWidth
            Height = $sideHeight
            Fill = $Palette.SideCard
        },
        @{
            X = $Size * 0.40
            Y = $centerY
            Width = $centerWidth
            Height = $centerHeight
            Fill = $Palette.PrimaryCard
        },
        @{
            X = $Size * 0.58
            Y = $sideY
            Width = $sideWidth
            Height = $sideHeight
            Fill = $Palette.SideCard
        }
    )

    foreach ($card in $cardSpecs) {
        $rect = [System.Drawing.RectangleF]::new(
            [float]$card.X,
            [float]$card.Y,
            [float]$card.Width,
            [float]$card.Height
        )
        $path = New-RoundedRectanglePath -Rect $rect -Radius $radius
        $Graphics.FillPath((New-Object System.Drawing.SolidBrush($card.Fill)), $path)
        $path.Dispose()
    }

    if ($Size -ge 32) {
        $dotRadius = [Math]::Max(1.0, $Size * 0.035)
        $dotY = $Size * 0.79
        foreach ($dotX in @(($Size * 0.43), ($Size * 0.50), ($Size * 0.57))) {
            $dotColor = if ([Math]::Abs($dotX - ($Size * 0.50)) -lt 0.1) { $Palette.MarkCenterDot } else { $Palette.MarkSideDot }
            $Graphics.FillEllipse(
                (New-Object System.Drawing.SolidBrush($dotColor)),
                $dotX - $dotRadius,
                $dotY - $dotRadius,
                $dotRadius * 2,
                $dotRadius * 2
            )
        }
    }

    $badgePath.Dispose()
}

function Draw-InstallerFileGlyph {
    param(
        [System.Drawing.Graphics]$Graphics,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius,
        [System.Drawing.Color]$FillColor,
        [System.Drawing.Color]$BorderColor,
        [System.Drawing.Color]$LineColor,
        [bool]$ShowLines = $true
    )

    $rect = [System.Drawing.RectangleF]::new([float]$X, [float]$Y, [float]$Width, [float]$Height)
    $path = New-RoundedRectanglePath -Rect $rect -Radius $Radius
    $Graphics.FillPath((New-Object System.Drawing.SolidBrush($FillColor)), $path)
    $Graphics.DrawPath((New-Object System.Drawing.Pen($BorderColor, [Math]::Max(1.0, $Width * 0.06))), $path)

    if ($ShowLines) {
        $linePen = New-Object System.Drawing.Pen($LineColor, [Math]::Max(1.0, $Width * 0.08))
        $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

        $lineX = $X + ($Width * 0.22)
        $lineWidth = $Width * 0.46
        foreach ($lineY in @(($Y + ($Height * 0.38)), ($Y + ($Height * 0.56)), ($Y + ($Height * 0.74)))) {
            $Graphics.DrawLine($linePen, $lineX, $lineY, $lineX + $lineWidth, $lineY)
        }

        $linePen.Dispose()
    }

    $path.Dispose()
}

function New-InstallerIconBitmap {
    param([int]$Size)

    $palette = @{
        Border = [System.Drawing.ColorTranslator]::FromHtml('#0B1220')
        SideCard = [System.Drawing.ColorTranslator]::FromHtml('#F8FAFC')
        PrimaryCard = [System.Drawing.ColorTranslator]::FromHtml('#14B8A6')
        SideLines = [System.Drawing.ColorTranslator]::FromHtml('#1F2937')
        PrimaryLines = [System.Drawing.ColorTranslator]::FromHtml('#ECFEFF')
    }

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $showLines = $Size -ge 32
    $sideWidth = $Size * 0.24
    $centerWidth = $Size * 0.30
    $sideHeight = $Size * 0.60
    $centerHeight = $Size * 0.74
    $sideY = $Size * 0.24
    $centerY = $Size * 0.13
    $radius = [Math]::Max(1.0, $Size * 0.065)

    Draw-InstallerFileGlyph -Graphics $graphics -X ($Size * 0.12) -Y $sideY -Width $sideWidth -Height $sideHeight -Radius $radius -FillColor $palette.SideCard -BorderColor $palette.Border -LineColor $palette.SideLines -ShowLines $showLines
    Draw-InstallerFileGlyph -Graphics $graphics -X ($Size * 0.64) -Y $sideY -Width $sideWidth -Height $sideHeight -Radius $radius -FillColor $palette.SideCard -BorderColor $palette.Border -LineColor $palette.SideLines -ShowLines $showLines
    Draw-InstallerFileGlyph -Graphics $graphics -X ($Size * 0.35) -Y $centerY -Width $centerWidth -Height $centerHeight -Radius $radius -FillColor $palette.PrimaryCard -BorderColor $palette.Border -LineColor $palette.PrimaryLines -ShowLines $showLines

    $graphics.Dispose()
    return $bitmap
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

    if ($Size -lt 48) {
        Draw-SmallAppIcon -Graphics $graphics -Palette $palette -Size $Size
        $graphics.Dispose()
        return $bitmap
    }

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

function Save-Bmp {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
}

function New-InstallerHeaderBitmap {
    $width = 150
    $height = 57
    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#F8FAFC'))
    $accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#14B8A6'))
    $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#E2E8F0'))
    $graphics.FillRectangle($lineBrush, 0, $height - 1, $width, 1)
    $graphics.FillRectangle($accentBrush, 0, $height - 3, 46, 3)

    $icon = New-AppIconBitmap -Size 256
    $graphics.DrawImage($icon, [System.Drawing.Rectangle]::new(102, 8, 40, 40))

    $icon.Dispose()
    $accentBrush.Dispose()
    $lineBrush.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function New-InstallerSidebarBitmap {
    $width = 164
    $height = 314
    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $background = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#0B1220'))
    $panel = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#111C2F'))
    $accent = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#14B8A6'))
    $muted = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#475569'))
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#F8FAFC'))
    $subtleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#94A3B8'))

    $graphics.FillRectangle($background, 0, 0, $width, $height)

    $panelRect = [System.Drawing.RectangleF]::new(18, 24, 128, 162)
    $panelPath = New-RoundedRectanglePath -Rect $panelRect -Radius 18
    $graphics.FillPath($panel, $panelPath)

    $icon = New-AppIconBitmap -Size 256
    $graphics.DrawImage($icon, [System.Drawing.Rectangle]::new(43, 48, 78, 78))

    $fontTitle = New-Object System.Drawing.Font('Segoe UI Semibold', 13, [System.Drawing.FontStyle]::Bold)
    $fontSmall = New-Object System.Drawing.Font('Segoe UI', 8.5)
    $graphics.DrawString('N-Way', $fontTitle, $textBrush, [System.Drawing.PointF]::new(28, 206))
    $graphics.DrawString('Compare', $fontTitle, $textBrush, [System.Drawing.PointF]::new(28, 226))
    $graphics.FillRectangle($accent, 28, 260, 42, 3)
    $graphics.FillRectangle($muted, 74, 260, 42, 3)
    $graphics.DrawString('Folder diff tool', $fontSmall, $subtleBrush, [System.Drawing.PointF]::new(28, 274))

    $icon.Dispose()
    $fontTitle.Dispose()
    $fontSmall.Dispose()
    $panelPath.Dispose()
    $background.Dispose()
    $panel.Dispose()
    $accent.Dispose()
    $muted.Dispose()
    $textBrush.Dispose()
    $subtleBrush.Dispose()
    $graphics.Dispose()
    return $bitmap
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
$installerIconPath = Join-Path $assetsDir 'installer-icon.ico'
$installerHeaderPath = Join-Path $assetsDir 'installer-header.bmp'
$installerSidebarPath = Join-Path $assetsDir 'installer-sidebar.bmp'

$masterBitmap = New-AppIconBitmap -Size 1024
Save-Png -Bitmap $masterBitmap -Path $pngPath
$masterBitmap.Dispose()

$icoImages = @()
foreach ($iconSize in @(16, 24, 32, 48, 64, 128, 256)) {
    $icoBitmap = New-AppIconBitmap -Size $iconSize
    $icoBytes = Get-PngBytes -Bitmap $icoBitmap
    $icoBitmap.Dispose()

    $icoImages += @{
        Size = $iconSize
        Bytes = $icoBytes
    }
}

Save-Ico -Path $icoPath -Images $icoImages

$installerIcoImages = @()
foreach ($iconSize in @(16, 24, 32, 48, 64, 128, 256)) {
    $installerIcoBitmap = New-InstallerIconBitmap -Size $iconSize
    $installerIcoBytes = Get-PngBytes -Bitmap $installerIcoBitmap
    $installerIcoBitmap.Dispose()

    $installerIcoImages += @{
        Size = $iconSize
        Bytes = $installerIcoBytes
    }
}

Save-Ico -Path $installerIconPath -Images $installerIcoImages

$installerHeaderBitmap = New-InstallerHeaderBitmap
Save-Bmp -Bitmap $installerHeaderBitmap -Path $installerHeaderPath
$installerHeaderBitmap.Dispose()

$installerSidebarBitmap = New-InstallerSidebarBitmap
Save-Bmp -Bitmap $installerSidebarBitmap -Path $installerSidebarPath
$installerSidebarBitmap.Dispose()

Write-Host "Generated $pngPath"
Write-Host "Generated $icoPath"
Write-Host "Generated $installerIconPath"
Write-Host "Generated $installerHeaderPath"
Write-Host "Generated $installerSidebarPath"
