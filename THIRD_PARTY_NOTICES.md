# Third-party notices

The MIT license in `LICENSE` covers Framewright's own source code (`index.html`, `style.css`, `app.js`, `*.worker.js`). The components below keep their own licenses.

## Bundled

### FFmpeg.wasm core (`ffmpeg/ffmpeg-core.js`, `ffmpeg/ffmpeg-core.wasm`)
- Project: ffmpeg.wasm, https://github.com/ffmpegwasm/ffmpeg.wasm (FFmpeg: https://ffmpeg.org)
- This build is configured with `--enable-gpl` and includes libx264 and libx265, so the bundled binaries are distributed under the **GNU General Public License, version 2 or later**. See https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
- Corresponding source: https://github.com/ffmpegwasm/ffmpeg.wasm and https://git.ffmpeg.org/ffmpeg.git
- The app loads these files only in a separate Web Worker, as a fallback. If you need an MIT-only distribution, remove the `ffmpeg/` folder; WebCodecs-supported files keep working.

## Loaded at runtime from esm.sh (not bundled)
- mp4box.js 0.5.3, BSD-3-Clause, https://github.com/gpac/mp4box.js
- mp4-muxer 5.1.3, MIT, https://github.com/Vanilagy/mp4-muxer

## Media
- `sample.mp4` is a synthetic test pattern generated for this project and is covered by the MIT license.
