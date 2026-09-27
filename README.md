# Framewright — WebCodecs Editor

A browser-based video editor. Decoding, compositing and encoding run in Web Workers using the WebCodecs API, with an FFmpeg.wasm fallback for containers and codecs WebCodecs can't handle. Large files are streamed from disk, and decoded audio is cached in OPFS.

Live: https://framewright.pplx.app

## Features
- Multi-clip sequences: add, reorder and remove clips, with letterboxing for clips of different shapes
- Fade-through-black transitions between clips (picture and audio)
- Trim, speed (slow motion to fast), rotation, including phone rotation metadata
- Colour effects, vignette, grain and a title layer
- Voice-over recording and import, with ducking
- Export to MP4, WebM, MOV or MKV
- Mobile layout

## Run locally
Static site with no build step:

```
python3 -m http.server 8123
```

Then open http://localhost:8123. Requires a Chromium-based browser or another browser with WebCodecs support.



## License
MIT for Framewright's own code; see `LICENSE`. The bundled FFmpeg.wasm core is GPL-2.0-or-later; see `THIRD_PARTY_NOTICES.md`.
