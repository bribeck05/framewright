// Engine worker: demux → VideoDecoder → WebGL2 compositor (OffscreenCanvas) → VideoEncoder/AudioEncoder → mp4-muxer
// The main thread only drives the clock and UI; all frame work happens here.
import * as MP4BoxNS from 'https://esm.sh/mp4box@0.5.3';
import { Muxer, StreamTarget } from 'https://esm.sh/mp4-muxer@5.1.3';
const MP4Box = MP4BoxNS.default ?? MP4BoxNS;
const post = (m, t) => self.postMessage(m, t || []);

// ---------------------------------------------------------------- Streaming source
// The source File stays on disk. Reads are random-access slices (FileReaderSync), so a
// multi-GB clip never has to fit in memory. Only the sample table (offsets/sizes) is kept.
class DiskSource {
  constructor(file) { this.file = file; this.size = file.size; this.reader = new FileReaderSync(); this.bytesRead = 0; }
  read(offset, size) {
    const ab = this.reader.readAsArrayBuffer(this.file.slice(offset, offset + size));
    this.bytesRead += ab.byteLength;
    return new Uint8Array(ab);
  }
}

// ---------------------------------------------------------------- Stage 1: demux (incremental)
// Feed mp4box 1 MB at a time. When it sees an mdat before the moov it returns the offset
// just past it, so we skip the media payload and only read the box headers + moov.
function demux(src) {
  const file = MP4Box.createFile();
  let info = null, err = null;
  file.onReady = (i) => (info = i);
  file.onError = (e) => (err = e);
  let pos = 0, reads = 0;
  const CHUNK = 1 << 20;
  while (!info && !err && pos < src.size) {
    const n = Math.min(CHUNK, src.size - pos);
    const ab = src.read(pos, n).buffer;
    ab.fileStart = pos;
    const next = file.appendBuffer(ab);
    pos = next > pos ? next : pos + n;
    if (++reads > 100000) break;
  }
  if (!info) file.flush();
  if (err) throw new Error('Demux failed: ' + err);
  if (!info) throw new Error('Not a readable MP4/MOV file');
  if (info.isFragmented) throw new Error('Fragmented MP4 (remux needed)');
  const track = info.videoTracks[0];
  if (!track?.codec) throw new Error('No video track found');
  const samples = file.getTrackById(track.id).samples;
  if (!samples?.length) throw new Error('Unreadable video track');
  const at = info.audioTracks[0];
  const audioSamples = at ? file.getTrackById(at.id).samples : null;
  return { file, info, track, samples, audioTrack: at, audioSamples, description: getDescription(file, track), headerBytes: src.bytesRead };
}

function getDescription(file, track) {
  if (!/^(avc|hvc|hev)/.test(track.codec || '')) return undefined; // VP9/AV1 decode without description
  const trak = file.getTrackById(track.id);
  for (const e of trak.mdia.minf.stbl.stsd.entries) {
    const box = e.avcC || e.hvcC;
    if (box) {
      const s = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer, 8); // strip box header
    }
  }
}

// ---------------------------------------------------------------- Stage 2: decode
class FrameSource {
  constructor(media, config, maxQueue = 6) {
    this.chunks = media.samples.map((s) => ({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round((s.cts * 1e6) / s.timescale),
      duration: Math.round((s.duration * 1e6) / s.timescale),
      offset: s.offset, size: s.size,
    }));
    this.src = media.src;
    this.config = config;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.frameDur = media.frameDur;
    this.decoded = 0; this.dropped = 0; this.gen = 0;
    this._newDecoder();
  }
  _newDecoder() {
    this.dec = new VideoDecoder({
      output: (f) => {
        if (f.timestamp + (f.duration || this.frameDur) <= this.dropBefore) { f.close(); this.dropped++; }
        else { this.queue.push(f); this.decoded++; }
        this._wake();
      },
      error: (e) => { console.error(e); post({ type: 'error', message: 'Decoder error: ' + e.message }); },
    });
    this.dec.configure(this.config);
  }
  seek(t) {
    this.gen++;
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.dec.state === 'closed') this._newDecoder();
    else { this.dec.reset(); this.dec.configure(this.config); }
    // last keyframe (decode order) whose presentation time ≤ t
    let k = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c.type === 'key') { if (c.timestamp <= t) k = i; else break; }
    }
    this.next = k; this.dropBefore = t; this.ended = false; this.flushing = false;
    this.pump();
  }
  pump() {
    if (this.dec.state !== 'configured') return;
    while (this.next < this.chunks.length && this.dec.decodeQueueSize < 4 && this.queue.length + this.dec.decodeQueueSize < this.maxQueue) {
      const c = this.chunks[this.next++];
      this.dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: this.src.read(c.offset, c.size) }));
    }
    if (this.next >= this.chunks.length && !this.flushing) {
      this.flushing = true;
      const g = this.gen;
      this.dec.flush().then(() => { if (g === this.gen) { this.ended = true; this._wake(); } }).catch(() => {});
    }
  }
  _release(t) { while (this.queue.length > 1 && this.queue[1].timestamp <= t) this.queue.shift().close(); }
  // Non-blocking (preview): frame covering t, or null
  peek(t) {
    this._release(t);
    this.pump();
    const f = this.queue[0];
    return f && f.timestamp <= t + this.frameDur / 2 ? f : null;
  }
  // Blocking (export): wait until the frame covering t is decoded
  async frameAt(t) {
    for (;;) {
      this._release(t);
      this.pump();
      const f = this.queue[0];
      if (f && (f.timestamp + (f.duration || this.frameDur) > t || this.queue.length > 1 || this.ended)) return f;
      if (this.ended && !f) return null;
      await new Promise((r) => { this._waiter = r; setTimeout(r, 30); });
    }
  }
  _wake() { const w = this._waiter; this._waiter = null; w && w(); }
  close() { for (const f of this.queue) f.close(); this.queue = []; if (this.dec.state !== 'closed') this.dec.close(); }
}

// ---------------------------------------------------------------- Stage 3: compositor
const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;
const FS_GRADE = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D uTex; uniform vec2 uRes;
uniform float uB, uC, uS, uT, uV, uG, uSeed; uniform int uRot;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uSeed) * 43758.5453); }
void main(){
  // Map output UV → source UV for the display rotation (clockwise quarter turns)
  vec2 sv = uRot == 1 ? vec2(v.y, 1. - v.x) : uRot == 2 ? vec2(1. - v.x, 1. - v.y) : uRot == 3 ? vec2(1. - v.y, v.x) : v;
  vec3 c = texture(uTex, sv).rgb;
  c += uB;
  c = (c - .5) * uC + .5;
  float l = dot(c, vec3(.2126,.7152,.0722));
  c = mix(vec3(l), c, uS);
  c += vec3(uT, uT*.15, -uT);
  vec2 d = v - .5; d.x *= uRes.x / uRes.y;
  c *= mix(1., smoothstep(.95, .25, length(d)), uV);
  c += (hash(floor(v*uRes)) - .5) * uG;
  o = vec4(clamp(c, 0., 1.), 1.);
}`;
const FS_OVER = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D uTex; uniform float uA; uniform float uDy;
void main(){ vec4 c = texture(uTex, v + vec2(0., uDy)); o = c * uA; }`;

class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.grade = this._prog(FS_GRADE);
    this.over = this._prog(FS_OVER);
    this.videoTex = this._tex();
    this.titleTex = this._tex();
    this.titleCanvas = new OffscreenCanvas(16, 16);
    this.titleKey = '';
  }
  _prog(fs) {
    const gl = this.gl;
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  _tex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  resize(w, h) { this.canvas.width = w; this.canvas.height = h; this.titleCanvas = new OffscreenCanvas(w, h); this.titleKey = ''; }
  _updateTitle(text, y) {
    const key = text + '|' + y;
    if (key === this.titleKey) return;
    this.titleKey = key;
    const c = this.titleCanvas, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (text) {
      // Size from the short edge so portrait output isn't oversized, then shrink to fit 90% width
      let size = Math.round(Math.min(c.width, c.height) * 0.07);
      const font = (s) => `600 ${s}px system-ui, "Helvetica Neue", Arial, sans-serif`;
      g.font = font(size);
      const tw = g.measureText(text).width, maxW = c.width * 0.86;
      if (tw > maxW) { size = Math.max(10, Math.floor(size * maxW / tw)); g.font = font(size); }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const w = g.measureText(text).width, py = c.height * y;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.beginPath(); g.roundRect(c.width / 2 - w / 2 - size * 0.6, py - size * 0.85, w + size * 1.2, size * 1.7, size * 0.3); g.fill();
      g.fillStyle = '#fff'; g.fillText(text, c.width / 2, py);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.titleTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
  // frame: VideoFrame; t: timeline seconds; fx: effect params
  draw(frame, t, fx) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.getParameter(gl.ARRAY_BUFFER_BINDING));
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // Layer 0: video with color-grade effect chain (fused into one pass)
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame); // GPU upload, YUV→RGB by the browser
    const g = this.grade; gl.useProgram(g.p);
    gl.uniform1i(g.u.uTex, 0); gl.uniform2f(g.u.uRes, W, H);
    gl.uniform1f(g.u.uB, fx.brightness); gl.uniform1f(g.u.uC, fx.contrast); gl.uniform1f(g.u.uS, fx.saturation);
    gl.uniform1f(g.u.uT, fx.temperature); gl.uniform1f(g.u.uV, fx.vignette); gl.uniform1f(g.u.uG, fx.grain);
    gl.uniform1f(g.u.uSeed, (t * 97.13) % 100); gl.uniform1i(g.u.uRot, this.rot || 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Layer 1: title with keyframed opacity + rise
    const { text, start, end, y } = fx.title;
    if (text && t >= start && t < end) {
      const fade = 0.4;
      const a = Math.min(1, (t - start) / fade, (end - t) / fade);
      this._updateTitle(text, y);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const o = this.over; gl.useProgram(o.p);
      gl.bindTexture(gl.TEXTURE_2D, this.titleTex);
      gl.uniform1i(o.u.uTex, 0); gl.uniform1f(o.u.uA, a); gl.uniform1f(o.u.uDy, -(1 - a) * 0.02);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

// ---------------------------------------------------------------- Stage 4/5: encode + mux
function avcCodecFor(w, h) { const a = w * h; return a <= 921600 ? 'avc1.64001f' : a <= 2228224 ? 'avc1.640028' : 'avc1.640033'; }
async function pickVideoEncoder(w, h, fps) {
  const base = { width: w, height: h, bitrate: Math.round(w * h * fps * 0.15), framerate: fps, latencyMode: 'quality' };
  const candidates = [
    { cfg: { ...base, codec: avcCodecFor(w, h), avc: { format: 'avc' } }, mux: 'avc', label: 'H.264' },
    { cfg: { ...base, codec: 'vp09.00.40.08' }, mux: 'vp9', label: 'VP9' },
    { cfg: { ...base, codec: 'av01.0.08M.08' }, mux: 'av1', label: 'AV1' },
  ];
  for (const c of candidates) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { ...c.cfg, hardwareAcceleration: hw };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { ...c, cfg }; } catch {}
    }
  }
  throw new Error('No supported video encoder config (H.264/VP9/AV1)');
}
async function pickAudioEncoder(sampleRate, numberOfChannels) {
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac', label: 'AAC' }, { codec: 'opus', mux: 'opus', label: 'Opus' }]) {
    const cfg = { codec: c.codec, sampleRate, numberOfChannels, bitrate: 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { ...c, cfg }; } catch {}
  }
  return null;
}


// ---------------------------------------------------------------- Rotation
// tkhd matrix = [a b u; c d v; x y w] in 16.16 fixed point. Rotation angle = atan2(b, a).
function rotationFromMatrix(m) {
  if (!m || m.length < 2) return 0;
  const a = m[0] / 65536, b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90;
  return ((deg % 360) + 360) % 360;
}
function applyRotation() {
  const m = W.media; if (!m) return;
  const rot = (m.rotation + W.extraRot) % 360, q = rot / 90;
  const w = m.width & ~1, h = m.height & ~1;
  W.comp.rot = q;
  if (q % 2) W.comp.resize(h, w); else W.comp.resize(w, h);
  W.rotation = rot;
  post({ type: 'rotated', rotation: rot, width: W.comp.canvas.width, height: W.comp.canvas.height });
}

// ---------------------------------------------------------------- Worker state + protocol
const W = { comp: null, media: null, src: null, late: 0, exporting: false, lastStats: 0 };

function stats(force) {
  const now = performance.now();
  if (!force && now - W.lastStats < 250) return;
  W.lastStats = now;
  const s = W.src;
  post({ type: 'stats', diskRead: W.media?.src?.bytesRead ?? 0, decodeQueue: s?.dec.decodeQueueSize ?? 0, queue: s?.queue.length ?? 0, decoded: s?.decoded ?? 0, dropped: s?.dropped ?? 0, late: W.late });
}


// ---------------------------------------------------------------- OPFS helpers
async function opfsDir(name) { return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// setTimeout is throttled (up to 1 s) in background tabs; a MessageChannel hop is not.
const yc = new MessageChannel(), yq = [];
yc.port1.onmessage = () => yq.shift()?.();
const yieldNow = () => new Promise((r) => { yq.push(r); yc.port2.postMessage(0); });
// Wait for a codec queue to drain one item (dequeue event), with a yield fallback
const drained = (codec) => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; codec.addEventListener?.('dequeue', f, { once: true }); yieldNow().then(() => setTimeout(f, 50)); });
function keyFor(file) {
  const s = `${file.name}|${file.size}|${file.lastModified}`;
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'a' + (h >>> 0).toString(36) + '-' + file.size.toString(36);
}

async function load(file, name) {
  if (W.audioBlocking) { W.audioWorker?.terminate(); W.audioBlocking = false; }
  W.src?.close(); W.src = null; W.media = null; W.audioGen = (W.audioGen || 0) + 1; W.audioWorker?.terminate(); W.audioWorker = null;
  const src = new DiskSource(file);
  let media;
  try { media = demux(src); }
  catch (e) { return post({ type: 'needsFallback', reason: 'container', detail: e.message }); }
  media.src = src;
  const t = media.track;
  const last = media.samples.reduce((m, s) => Math.max(m, ((s.cts + s.duration) * 1e6) / s.timescale), 0);
  media.dur = Math.round(last);
  // Nominal fps from the most common sample duration (robust to B-frame CTS offsets / edit lists)
  const hist = new Map(); for (const s of media.samples) hist.set(s.duration, (hist.get(s.duration) || 0) + 1);
  const common = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const ts0 = media.samples[0].timescale;
  media.fps = common > 0 ? Math.round((ts0 / common) * 1000) / 1000 : 30;
  media.frameDur = 1e6 / media.fps;
  media.width = t.video?.width ?? t.track_width; media.height = t.video?.height ?? t.track_height;
  media.rotation = rotationFromMatrix(t.matrix);
  const config = { codec: t.codec, codedWidth: media.width, codedHeight: media.height, description: media.description, optimizeForLatency: true };
  let ok = false;
  try { ok = (await VideoDecoder.isConfigSupported(config)).supported; } catch {}
  if (!ok) return post({ type: 'needsFallback', reason: 'codec', detail: t.codec });
  media.config = config;
  media.key = keyFor(file);
  W.media = media;
  W.extraRot = 0; applyRotation();
  W.src = new FrameSource(media, config);
  W.src.seek(0);
  W.late = 0;
  post({ type: 'loaded', meta: {
    name, codec: t.codec, width: media.width, height: media.height, fps: media.fps, dur: media.dur,
    rotation: media.rotation, samples: media.samples.length, keyframes: media.samples.filter((s) => s.is_sync).length,
    hasAudio: !!media.audioTrack, key: media.key, fileSize: file.size, headerBytes: media.headerBytes,
  } });
  if (media.audioTrack && !self.NOAUD) decodeAudioToPCM(media, W.audioGen).catch((e) => post({ type: 'audioUnsupported', key: media.key, reason: e.message }));
}

// ---------------------------------------------------------------- Audio → PCM cache in OPFS
// Compressed audio is decoded once with AudioDecoder and written as interleaved f32 to OPFS.
// Playback and export then stream from that file; a sidecar JSON caches metadata + waveform peaks.
function audioConfig(media) {
  const at = media.audioTrack, e = media.file.getTrackById(at.id).mdia.minf.stbl.stsd.entries[0];
  const base = { sampleRate: at.audio.sample_rate, numberOfChannels: at.audio.channel_count };
  if (/^mp4a\.40/.test(at.codec)) {
    const dsi = e.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    return { ...base, codec: at.codec, ...(dsi ? { description: new Uint8Array(dsi) } : {}) };
  }
  if (/^mp4a\.(6b|69)$/.test(at.codec)) return { ...base, codec: 'mp3' };
  if (/opus/i.test(at.codec) || e.type === 'Opus') {
    const d = e.dOps, head = new Uint8Array(19), v = new DataView(head.buffer);
    head.set([79, 112, 117, 115, 72, 101, 97, 100]); // "OpusHead"
    head[8] = 1; head[9] = d?.OutputChannelCount ?? base.numberOfChannels;
    v.setUint16(10, d?.PreSkip ?? 312, true); v.setUint32(12, d?.InputSampleRate ?? 48000, true);
    v.setInt16(16, d?.OutputGain ?? 0, true); head[18] = d?.ChannelMappingFamily ?? 0;
    return { ...base, sampleRate: 48000, codec: 'opus', description: head };
  }
  return null;
}
async function readMeta(key) {
  try { const dir = await opfsDir('cache'); const f = await (await dir.getFileHandle(key + '.json')).getFile(); return JSON.parse(await f.text()); } catch { return null; }
}
async function writeMeta(key, meta) {
  const dir = await opfsDir('cache');
  const w = await (await dir.getFileHandle(key + '.json', { create: true })).createWritable();
  await w.write(JSON.stringify(meta)); await w.close();
}
async function pruneCache(keep) {
  const dir = await opfsDir('cache');
  for await (const [n] of dir.entries()) if (!n.startsWith(keep)) { try { await dir.removeEntry(n); } catch {} }
}
async function decodeAudioToPCM(media, gen) {
  const key = media.key;
  const cached = await readMeta(key);
  if (cached?.complete) { W.pcm = cached; return post({ type: 'audioReady', ...cached, cached: true }); }
  await pruneCache(key); // keep OPFS usage bounded to the current project
  const cfg = audioConfig(media);
  let ok = false; try { ok = cfg && (await AudioDecoder.isConfigSupported(cfg)).supported; } catch {}
  if (!ok) return post({ type: 'audioUnsupported', key, reason: `AudioDecoder can't decode ${media.audioTrack.codec}` });
  // Decode in a separate worker: a live VideoDecoder holding preview frames can starve an
  // AudioDecoder on the same thread, and this keeps scrubbing responsive during long decodes.
  const at = media.audioTrack;
  const samples = media.audioSamples.map((x) => [x.offset, x.size, x.cts, x.duration, x.timescale]);
  const job = { file: media.src.file, samples, cfg, key, estSec: at.duration / at.timescale, outCh: Math.min(2, at.audio.channel_count || 2) };
  const runAudio = (stallMs) => new Promise((resolve, reject) => {
    W.audioWorker?.terminate();
    const aw = W.audioWorker = new Worker(new URL('./audio.worker.js', import.meta.url), { type: 'module' });
    let last = performance.now();
    const dog = setInterval(() => { if (performance.now() - last > stallMs) { clearInterval(dog); aw.terminate(); reject(Object.assign(new Error('stalled'), { stalled: true })); } }, 500);
    const end = () => { clearInterval(dog); aw.terminate(); if (W.audioWorker === aw) W.audioWorker = null; };
    aw.onmessage = ({ data: m }) => {
      last = performance.now();
      if (m.type === 'progress') post({ type: 'audioProgress', pct: m.pct });
      else if (m.type === 'done') { end(); resolve(m.meta); }
      else if (m.type === 'error') { end(); reject(new Error(m.message)); }
    };
    aw.onerror = (e) => { end(); reject(new Error(e.message || 'audio worker failed')); };
    aw.postMessage(job);
  });
  let meta;
  try { meta = await runAudio(4000); }
  catch (e) {
    if (!e.stalled || gen !== W.audioGen) throw e;
    // Some software video decoders (seen with VP9 / baseline H.264) starve AudioDecoder while
    // active. Park the preview decoder, decode audio, then bring the preview back.
    post({ type: 'audioProgress', pct: 0, note: 'preview paused while audio decodes' });
    W.audioBlocking = true; W.src?.close(); W.src = null;
    try { meta = await runAudio(15000); }
    finally { W.audioBlocking = false; if (gen === W.audioGen && W.media === media) { W.src = new FrameSource(media, media.config); W.src.seek(W.lastT || 0); } }
  }
  if (gen !== W.audioGen) return;
  await writeMeta(key, meta);
  W.pcm = meta;
  post({ type: 'audioReady', ...meta, cached: false });
}
// Fallback: main thread decoded audio (decodeAudioData) for codecs AudioDecoder lacks; persist it the same way.
async function writePCM({ key, sampleRate, channels }) {
  const dir = await opfsDir('cache');
  const h = await (await dir.getFileHandle(key + '.f32', { create: true })).createSyncAccessHandle();
  h.truncate(0);
  const ch = channels.length, len = channels[0].length, BLK = 65536, BINS = 2000, peaks = new Float32Array(BINS), binSize = Math.max(1, Math.ceil(len / BINS));
  for (let o = 0; o < len; o += BLK) {
    const n = Math.min(BLK, len - o), inter = new Float32Array(n * ch);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) inter[i * ch + c] = channels[c][o + i];
    for (let i = 0; i < n; i++) { const b = Math.floor((o + i) / binSize), v = Math.abs(inter[i * ch]); if (v > peaks[b]) peaks[b] = v; }
    h.write(inter, { at: o * ch * 4 });
  }
  h.flush(); h.close();
  const meta = { key, sampleRate, channels: ch, frames: len, peaks: Array.from(peaks), complete: true };
  await writeMeta(key, meta); W.pcm = meta;
  post({ type: 'audioReady', ...meta, cached: false });
}

function frame({ t, fx, playing }) {
  if (!W.src || W.exporting) return;
  const f = W.src.peek(Math.min(t, W.media.dur - 1));
  if (f) W.comp.draw(f, t / 1e6, fx);
  else if (playing) W.late++;
  stats();
}

// Streams the output mix block-by-block: source PCM (varispeed resample) × gain × ducking + voice-over.
async function exportJob({ inT, outT, fx, gain, speed = 1, vo = [], duck = 1, voGain = 1, format = 'mp4' }) {
  const m = W.media; if (!m || W.exporting) return;
  W.exporting = true;
  const canvas = W.comp.canvas, Wd = canvas.width, H = canvas.height, fps = m.fps;
  let xsrc, pcmH, outH;
  try {
    const pcm = W.pcm && W.pcm.key === m.key ? W.pcm : null;
    const sr = pcm?.sampleRate ?? 48000, ch = pcm?.channels ?? 2;
    const hasAudio = !!pcm || vo.length > 0;
    const venc = await pickVideoEncoder(Wd, H, fps);
    const aenc = hasAudio ? await pickAudioEncoder(sr, ch) : null;
    // Output streams straight to OPFS — the finished file never sits in memory
    const dir = await opfsDir('exports');
    for await (const [n] of dir.entries()) { try { await dir.removeEntry(n); } catch {} }
    const outName = `export-${Date.now()}.mp4`;
    outH = await (await dir.getFileHandle(outName, { create: true })).createSyncAccessHandle();
    let written = 0;
    const target = new StreamTarget({ onData: (data, position) => { outH.write(data, { at: position }); written = Math.max(written, position + data.byteLength); }, chunked: true, chunkSize: 4 * 1024 * 1024 });
    const muxer = new Muxer({
      target,
      video: { codec: venc.mux, width: Wd, height: H, frameRate: Math.max(1, Math.round(fps)) },
      ...(aenc ? { audio: { codec: aenc.mux, sampleRate: aenc.cfg.sampleRate, numberOfChannels: aenc.cfg.numberOfChannels } } : {}),
      fastStart: false, firstTimestampBehavior: 'offset',
    });
    let err = null;
    const labels = `${venc.label}${aenc ? ' + ' + aenc.label : ''}`;
    if (aenc) {
      post({ type: 'progress', pct: 0, msg: `Mixing + encoding audio (${aenc.label}) from disk…` });
      const ae = new AudioEncoder({ output: (c, meta) => muxer.addAudioChunk(c, meta), error: (e) => (err = e) });
      ae.configure(aenc.cfg);
      if (pcm) pcmH = await (await (await opfsDir('cache')).getFileHandle(pcm.key + '.f32')).createSyncAccessHandle();
      const s0 = (inT / 1e6) * sr, srcEnd = pcm ? Math.min(pcm.frames, (outT / 1e6) * sr) : 0;
      const outLen = Math.max(1, Math.round(((outT - inT) / speed / 1e6) * sr));
      // voice-over clips in output-sample coordinates
      const clips = vo.map((c) => ({ s: Math.round(((c.start - inT) / speed / 1e6) * sr), ratio: c.sampleRate / sr, chans: c.channels, n: Math.round((c.channels[0].length / c.sampleRate) * sr) }));
      const ramp = Math.round(0.15 * sr);
      const env = (i) => { let e = 1; for (const c of clips) { const k = i < c.s - ramp || i >= c.s + c.n + ramp ? 1 : i < c.s ? 1 - (i - (c.s - ramp)) / ramp : i >= c.s + c.n ? (i - (c.s + c.n)) / ramp : 0; e = Math.min(e, duck + (1 - duck) * k); } return e; };
      const BLK = 1024;
      for (let o = 0; o < outLen; o += BLK) {
        const n = Math.min(BLK, outLen - o), data = new Float32Array(n * ch);
        if (pcm) {
          const a = Math.floor(s0 + o * speed), b = Math.min(pcm.frames, Math.floor(s0 + (o + n) * speed) + 2);
          if (b > a) {
            const win = new Float32Array(b - a > 0 ? (b - a) * ch : 0);
            pcmH.read(win, { at: a * ch * 4 });
            for (let i = 0; i < n; i++) {
              const x = s0 + (o + i) * speed; if (x >= srcEnd) break;
              const k = Math.floor(x) - a, f = x - Math.floor(x), g = gain * env(o + i);
              for (let c = 0; c < ch; c++) {
                const v0 = win[k * ch + c] ?? 0, v1 = win[(k + 1) * ch + c] ?? v0;
                data[c * n + i] = (v0 * (1 - f) + v1 * f) * g;
              }
            }
          }
        }
        for (const c of clips) {
          const from = Math.max(o, c.s), to = Math.min(o + n, c.s + c.n);
          for (let i = from; i < to; i++) {
            const x = Math.floor((i - c.s) * c.ratio);
            for (let k = 0; k < ch; k++) { const src = c.chans[Math.min(k, c.chans.length - 1)]; if (x < src.length) data[k * n + (i - o)] += src[x] * voGain; }
          }
        }
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((o * 1e6) / sr), data });
        ae.encode(ad); ad.close();
        while (ae.encodeQueueSize > 8) await drained(ae);
        if (err) throw err;
        if ((o / BLK) % 200 === 0) post({ type: 'progress', pct: (o / outLen) * 20, msg: `Mixing + encoding audio (${aenc.label}) from disk… ${Math.round((o / outLen) * 100)}%` });
      }
      await ae.flush(); ae.close();
      pcmH?.close(); pcmH = null;
    }
    xsrc = new FrameSource(m, m.config, 4);
    xsrc.seek(inT);
    const total = Math.max(1, Math.round((outT - inT) / speed / m.frameDur));
    const gop = Math.round(fps * 2), dur = Math.round(1e6 / fps), started = performance.now();
    const ve = new VideoEncoder({ output: (c, meta) => muxer.addVideoChunk(c, meta), error: (e) => (err = e) });
    ve.configure(venc.cfg);
    for (let n = 0; n < total; n++) {
      const ts = Math.round((n * 1e6) / fps), tSrc = inT + Math.round(ts * speed);
      const f = await xsrc.frameAt(Math.min(tSrc, m.dur - 1));
      if (f) W.comp.draw(f, tSrc / 1e6, fx);
      const vf = new VideoFrame(canvas, { timestamp: ts, duration: dur });
      while (ve.encodeQueueSize > 4) await drained(ve);
      ve.encode(vf, { keyFrame: n % gop === 0 });
      vf.close();
      if (err) throw err;
      if (n % 5 === 0) {
        const rate = (n + 1) / ((performance.now() - started) / 1000);
        post({ type: 'progress', pct: (aenc ? 20 : 0) + ((n + 1) / total) * (aenc ? 80 : 100), t: tSrc, msg: `${labels} · frame ${n + 1}/${total} · ${rate.toFixed(0)} fps · ${(written / 1e6).toFixed(1)} MB written to disk` });
      }
    }
    await ve.flush(); ve.close();
    muxer.finalize();
    outH.flush(); outH.close(); outH = null;
    post({ type: 'exported', name: outName, size: written, frames: total, labels, video: venc.label, audio: aenc?.label ?? null, secs: (performance.now() - started) / 1000 });
  } catch (e) {
    post({ type: 'exportError', message: e.message || String(e) });
  } finally {
    try { pcmH?.close(); } catch {}
    try { outH?.close(); } catch {}
    xsrc?.close();
    W.exporting = false;
  }
}

async function clearStorage() {
  const root = await navigator.storage.getDirectory();
  for (const d of ['cache', 'exports']) { try { await root.removeEntry(d, { recursive: true }); } catch {} }
  W.pcm = null;
  post({ type: 'storageCleared' });
}

self.onmessage = ({ data: m }) => {
  switch (m.type) {
    case 'init':
      try { W.comp = new Compositor(m.canvas); post({ type: 'ready', webcodecs: 'VideoDecoder' in self && 'VideoEncoder' in self }); }
      catch (e) { post({ type: 'error', message: e.message }); }
      break;
    case 'load': load(m.file, m.name).catch((e) => post({ type: 'needsFallback', reason: 'codec', detail: e.message })); break;
    case 'writePCM': writePCM(m).catch((e) => post({ type: 'audioUnsupported', key: m.key, reason: e.message })); break;
    case 'seek': W.lastT = m.t; W.src?.seek(m.t); break;
    case 'rotate': if (!W.exporting) { W.extraRot = (W.extraRot + 90) % 360; applyRotation(); W.src?.seek(m.t ?? 0); } break;
    case 'frame': frame(m); break;
    case 'export': exportJob(m); break;
    case 'clearStorage': clearStorage(); break;
  }
};
