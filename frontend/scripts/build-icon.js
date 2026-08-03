// Regenerates frontend/electron/icon.ico from pre-sized PNGs in
// frontend/assets/ico-layers/. Order matters: to-ico writes layers in
// the buffer array order, and Windows Explorer treats Layer 1 as the
// "primary" size for large thumbnails. We therefore feed 256 FIRST so
// Windows always picks the crisp full-size layer when rendering the
// desktop shortcut, Start-menu tile, and installer thumbnail.
//
// Why this exists: png-to-ico auto-picks a small primary (48×48) and
// drops layers we ask for, producing an .ico that renders as a tiny
// badge top-left of a big white slot on the desktop (real report on
// v1.10.293). Passing pre-sized PNGs in explicit order via to-ico is
// the only path that both keeps every size AND puts 256 as primary.
//
// USAGE — run these two steps from the repo root when the source logo
// (frontend/assets/icon-square.png) changes:
//
//   1. Generate the per-size PNG layers (PowerShell, one-shot):
//        Add-Type -AssemblyName System.Drawing
//        $src = "$PWD\frontend\assets\icon-square.png"
//        $img = [System.Drawing.Image]::FromFile($src)
//        $tmp = "$PWD\frontend\assets\ico-layers"
//        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
//        New-Item -ItemType Directory $tmp | Out-Null
//        foreach ($s in 256,128,96,64,48,32,24,16) {
//            $bmp = New-Object System.Drawing.Bitmap $s,$s
//            $g = [System.Drawing.Graphics]::FromImage($bmp)
//            $g.InterpolationMode = 'HighQualityBicubic'
//            $g.DrawImage($img, 0, 0, $s, $s); $g.Dispose()
//            $bmp.Save("$tmp\$s.png", 'Png'); $bmp.Dispose()
//        }
//        $img.Dispose()
//   2. Compose the .ico from those layers:
//        node frontend/scripts/build-icon.js
//   3. Delete the temp folder:
//        Remove-Item frontend/assets/ico-layers -Recurse -Force
//
// The generated .ico is committed to the repo; the temp layer PNGs
// are NOT (they're regeneratable from icon-square.png at any time).

const fs = require('fs');
const path = require('path');
const toIco = require('to-ico');

const layersDir = path.join(__dirname, '..', 'assets', 'ico-layers');
const outFile = path.join(__dirname, '..', 'electron', 'icon.ico');

const sizes = [256, 128, 96, 64, 48, 32, 24, 16];

const buffers = sizes.map(function (s) {
  const p = path.join(layersDir, s + '.png');
  if (!fs.existsSync(p)) {
    throw new Error('Missing pre-sized layer: ' + p);
  }
  return fs.readFileSync(p);
});

toIco(buffers).then(function (icoBuffer) {
  fs.writeFileSync(outFile, icoBuffer);
  console.log('Wrote ' + outFile + ' — ' + icoBuffer.length + ' bytes, ' + sizes.length + ' layers, primary = ' + sizes[0] + '×' + sizes[0]);
}).catch(function (err) {
  console.error('Failed to build icon.ico:', err);
  process.exit(1);
});
