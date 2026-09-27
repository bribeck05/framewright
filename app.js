// Framewright — main thread: UI, timeline, audio clock, and worker orchestration.
// Heavy work lives in workers:
//   engine.worker.js  → demux, VideoDecoder, WebGL2 compositor on OffscreenCanvas, VideoEncoder/AudioEncoder, mp4-muxer
//   ffmpeg.worker.js  → FFmpeg.wasm fallback (unsupported containers/codecs, MOV/MKV muxing)
const $ = (id) => document.getElementById(id);
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 7000); };
const fmt = (us) => { const s = Math.max(0, us) / 1e6; const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };

// ---------------------------------------------------------------- Workers
const engine = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
let ffWorker = null, ffJobId = 0;
const ffPending = new Map();
function ffmpeg(input, args, output, label) {
  ffWorker ??= (() => {
    const w = new Worker(new URL('./ffmpeg.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = ({ data: m }) => {
      if (m.type === 'status') setStatus(m.msg);
      else if (m.type === 'progress') setProgress(m.progress * 100);
      else if (m.type === 'done' || m.type === 'error') {
        const p = ffPending.get(m.id); ffPending.delete(m.id);
        if (m.logs) console.log('[ffmpeg]', m.logs.join('\n'));
        m.type === 'done' ? p.resolve(m) : p.reject(new Error(m.message));
      }
    };
    return w;
  })();
  const id = ++ffJobId;
  S.ffmpegUsed = label;
  return new Promise((resolve, reject) => {
    ffPending.set(id, { resolve, reject });
    ffWorker.postMessage({ id, input, args, output }, input.data ? [input.data] : []);
  });
}

// ---------------------------------------------------------------- State
const S = {
  meta: null, audioCtx: null, audioBuf: null, gainNode: null, node: null,
  dur: 0, inT: 0, outT: 0, pos: 0, playing: false, base: 0, t0: 0, exporting: false,
  busy: false, stats: {}, speed: 1, clips: [], vo: [], voNodes: [], rec: null, ffmpegUsed: null, pipeline: 'WebCodecs',
};
window.__S = S; window.__engine = engine;
const fx = () => ({
  brightness: +$('brightness').value, contrast: +$('contrast').value, saturation: +$('saturation').value,
  temperature: +$('temperature').value, vignette: +$('vignette').value, grain: +$('grain').value,
  fade: S.clips.length > 1 ? +$('fade').value : 0,
  title: { text: $('titleText').value, start: +$('titleStart').value, end: +$('titleEnd').value, y: +$('titleY').value },
});

// Engine request/response helpers for load
let loadWaiter = null;
engine.onmessage = ({ data: m }) => {
  switch (m.type) {
    case 'ready': if (!m.webcodecs) toast('This browser lacks WebCodecs in workers. Use a recent Chrome, Edge, or Safari 26+.'); break;
    case 'loaded': case 'needsFallback': loadWaiter?.(m); loadWaiter = null; break;
    case 'clips': syncClips(m.clips, m.dur); break;
    case 'stats': S.stats = m; break;
    case 'rotated': S.rot = m; document.documentElement.style.setProperty('--ar', `${m.width} / ${m.height}`); updateStats(); window.__rot = m; break;
    case 'progress': setProgress(m.pct); setStatus(m.msg); if (m.t != null) { $('tc').textContent = `${fmt(m.t)} / ${fmt(S.dur)}`; positionPlayhead(m.t); } break;
    case 'exported': onExported(m); break;
    case 'exportError': onExportError(m.message); break;
    case 'error': toast(m.message); console.error(m.message); break;
    case 'audioProgress': { const c = S.clips.find((x) => x.key === m.key) || S.clips.find((x) => x.hasAudio && !x.pcm); if (c) { c.audioStatus = `decoding to disk ${m.pct.toFixed(0)}%${m.note ? ' (' + m.note + ')' : ''}`; drawWave(); } break; }
    case 'audioReady': onAudioReady(m); break;
    case 'audioUnsupported': onAudioUnsupported(m); break;
    case 'storageCleared': toast('Cleared cached audio and exports from browser storage.'); refreshStorage(); break;
  }
};
const canvasEl = $('view');
const offscreen = canvasEl.transferControlToOffscreen();
engine.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);

function engineLoad(file, name, append) {
  // File objects are disk-backed references; posting one to the worker copies nothing.
  return new Promise((resolve) => { loadWaiter = resolve; engine.postMessage({ type: 'load', file, name, append }); });
}
// Merge the worker's sequence layout into our clip records (keeps per-clip audio state)
function syncClips(list, dur) {
  const old = new Map(S.clips.map((c) => [c.id, c]));
  S.clips = list.map((c) => Object.assign(old.get(c.id) || { audioStatus: c.hasAudio ? 'waiting' : 'none' }, c));
  const wasFull = S.outT >= S.dur - 1;
  S.dur = dur;
  if (!S.clips.length) { resetEmpty(); return; }
  if (wasFull || S.outT > dur) S.outT = dur;
  S.inT = Math.min(S.inT, S.outT - 1e5 > 0 ? S.outT - 1e5 : 0);
  S.pos = Math.min(S.pos, dur - 1);
  S.meta = { ...S.meta, ...S.clips[0].meta };
  drawWave(); layoutTimeline(); renderClipList(); updateStats();
}
function resetEmpty() {
  S.meta = null; S.dur = 0; S.inT = S.outT = S.pos = 0;
  $('empty').hidden = false;
  for (const id of ['play', 'setIn', 'setOut', 'export', 'rotate', 'addLabel']) { const el = $(id); if (el) { el.disabled = true; el.classList?.toggle('disabled', id === 'addLabel'); } }
  $('tc').textContent = '00:00.000 / 00:00.000';
  drawWave(); layoutTimeline(); renderClipList();
}
const clipAt = (t) => S.clips.find((c) => t < c.start + c.dur) || S.clips[S.clips.length - 1];

// ---------------------------------------------------------------- Loading with FFmpeg.wasm fallback
async function proxyVideoArgs() {
  // Transcode to whatever this browser's VideoDecoder supports
  const ok = async (codec) => { try { return (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1280, codedHeight: 720 })).supported; } catch { return false; } };
  const scale = ['-vf', 'scale=min(1280\\,iw):-2'];
  if (await ok('avc1.42E01F')) return { label: 'H.264 proxy', args: [...scale, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '30'] };
  return { label: 'VP9 proxy', args: [...scale, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-g', '30', '-pix_fmt', 'yuv420p'] };
}
const extOf = (name) => (name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.bin').toLowerCase();

async function loadFile(file, name = file.name, append = false) {
  if (S.busy) return;
  S.busy = true; setBusy(true);
  pause();
  try {
    S.audioCtx ??= new AudioContext({ sampleRate: 48000 });
    navigator.storage?.persist?.().catch(() => {});
    S.ffmpegUsed = null; S.pipeline = 'WebCodecs (streamed from disk)';
    append = append && S.clips.length > 0;
    let srcFile = file;
    let res = await engineLoad(file, name, append);
    if (res.type === 'needsFallback') {
      showExportBox(); $('download').hidden = true; $('result').hidden = true;
      const inName = 'input' + extOf(name);
      if (res.reason === 'container') {
        setStatus(`Container not readable by mp4box (${name}). Remuxing with FFmpeg.wasm…`);
        try {
          const r = await ffmpeg({ name: inName, file }, ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', 'out.mp4'], 'out.mp4', 'remux → MP4');
          srcFile = new File([r.data], 'proxy.mp4', { lastModified: Date.now() });
          res = await engineLoad(srcFile, name, append);
          S.pipeline = 'FFmpeg.wasm remux → WebCodecs';
        } catch (e) { console.warn('remux failed, transcoding', e); res = { type: 'needsFallback', reason: 'codec', detail: 'remux failed' }; }
      }
      if (res.type === 'needsFallback') {
        const p = await proxyVideoArgs();
        setStatus(`WebCodecs can't decode ${res.detail}. Transcoding ${p.label} with FFmpeg.wasm…`);
        const r = await ffmpeg({ name: inName, file }, ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', ...p.args, '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', 'out.mp4'], 'out.mp4', p.label);
        srcFile = new File([r.data], 'proxy.mp4', { lastModified: Date.now() });
        res = await engineLoad(srcFile, name, append);
        S.pipeline = `FFmpeg.wasm ${p.label} → WebCodecs`;
        if (res.type !== 'loaded') throw new Error('Could not decode the transcoded proxy');
      }
      setStatus(`Loaded via ${S.pipeline}`); setProgress(100);
    }
    const meta = res.meta;
    if (!append) { S.clips = []; S.inT = 0; S.outT = res.seqDur; S.pos = 0; S.dur = res.seqDur; S.meta = meta; }
    else if (S.outT >= S.dur - 1) S.outT = res.seqDur; // keep an untrimmed end glued to the new end
    syncClips(res.clips, res.seqDur);
    const clip = S.clips.find((c) => c.id === res.clipId);
    Object.assign(clip, { meta, srcFile, pipeline: S.pipeline });
    if (clip === S.clips[0]) S.meta = meta;
    if (clip.pendingAudio) { const m = clip.pendingAudio; clip.pendingAudio = null; m.type === 'audioReady' ? onAudioReady(m) : onAudioUnsupported(m); }
    if (!S.gainNode) { S.gainNode = S.audioCtx.createGain(); S.gainNode.connect(S.audioCtx.destination); }
    $('empty').hidden = true;
    for (const id of ['play', 'setIn', 'setOut', 'export', 'rotate']) $(id).disabled = false;
    $('addLabel').classList.remove('disabled');
    if (!append) $('titleEnd').value = Math.min(+$('titleEnd').value, S.dur / 1e6).toFixed(1);
    drawWave(); layoutTimeline(); renderClipList(); updateStats(); refreshStorage();
    if (append) toast(`Added "${name}" at ${fmt(clip.start)}. Sequence is now ${fmt(S.dur)}.`);
    window.__loaded = { clips: S.clips.length, seqDur: S.dur, pipeline: S.pipeline, codec: meta.codec, headerBytes: meta.headerBytes, fileSize: meta.fileSize };
  } catch (e) { console.error(e); toast(e.message); setStatus('Load failed: ' + e.message); window.__loaded = { error: e.message }; }
  finally { S.busy = false; setBusy(false); }
}
async function onAudioReady(m) {
  const targets = S.clips.filter((c) => c.key === m.key);
  if (!targets.length) return;
  if (targets.some((c) => !c.meta)) { for (const c of targets) c.pendingAudio = m; if (targets.every((c) => !c.meta)) return; }
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('cache');
  const file = await (await dir.getFileHandle(m.key + '.f32')).getFile();
  for (const c of targets) { c.pcm = m; c.pcmFile = file; c.audioStatus = m.cached ? 'from disk cache' : 'decoded to disk'; }
  drawWave(); updateStats(); refreshStorage();
  window.__audio = { frames: m.frames, sampleRate: m.sampleRate, channels: m.channels, cached: m.cached, bytes: file.size, ready: S.clips.filter((c) => c.pcm).length };
}
async function onAudioUnsupported(m) {
  const c = S.clips.find((x) => x.key === m.key); if (!c) return;
  if (!c.srcFile) { c.pendingAudio = m; return; }
  // Fallback: the browser's own decoder needs the whole file in memory, so only for smaller files
  const LIMIT = 400 * 1024 * 1024;
  if (c.srcFile.size > LIMIT) { c.audioStatus = 'unsupported (file too large for fallback)'; toast(`Audio skipped for ${c.name}: ${m.reason}`); updateStats(); return; }
  try {
    c.audioStatus = 'fallback decode…';
    const ab = await S.audioCtx.decodeAudioData(await c.srcFile.arrayBuffer());
    const ch = Math.min(2, ab.numberOfChannels), channels = Array.from({ length: ch }, (_, k) => ab.getChannelData(k).slice());
    engine.postMessage({ type: 'writePCM', key: m.key, sampleRate: ab.sampleRate, channels }, channels.map((x) => x.buffer));
  } catch (e) { c.audioStatus = 'unsupported'; toast(`Audio could not be decoded for ${c.name}: ${e.message}`); updateStats(); }
}
async function refreshStorage() {
  try { const e = await navigator.storage.estimate(); S.storage = `${(e.usage / 1e6).toFixed(1)} MB used`; updateStats(); } catch {}
}

// ---------------------------------------------------------------- Playback (audio clock is master)
function clockNow() {
  if (!S.playing) return S.pos;
  if (S.audioCtx) {
    const lat = S.audioCtx.outputLatency || S.audioCtx.baseLatency || 0;
    return S.base + Math.max(0, S.audioCtx.currentTime - S.t0 - lat) * 1e6 * S.speed;
  }
  return S.base + (performance.now() - S.t0) * 1000 * S.speed;
}
// Read ~1 s of interleaved f32 PCM from a clip's OPFS cache into an AudioBuffer
async function readSegment(c, frame, n) {
  const p = c.pcm, ch = p.channels;
  const f = new Float32Array(await c.pcmFile.slice(frame * ch * 4, (frame + n) * ch * 4).arrayBuffer());
  const len = f.length / ch; if (!len) return null;
  const buf = S.audioCtx.createBuffer(ch, len, p.sampleRate);
  const fade = fx().fade, sr = p.sampleRate;
  for (let k = 0; k < ch; k++) { const d = buf.getChannelData(k); for (let i = 0; i < len; i++) d[i] = f[i * ch + k] * (fade ? fadeK(c.start + ((frame + i) / sr) * 1e6, fade) : 1); }
  return buf;
}
// Same curve as the engine: audio dips with the picture at each cut
function fadeK(t, fade) {
  if (!fade || S.clips.length < 2) return 1;
  const c = clipAt(t), i = S.clips.indexOf(c), half = (fade * 1e6) / 2;
  const dIn = i > 0 ? t - c.start : Infinity, dOut = i < S.clips.length - 1 ? c.start + c.dur - t : Infinity;
  const k = Math.min(1, Math.max(0, Math.min(dIn, dOut) / half));
  return k * k * (3 - 2 * k);
}
// Walk the sequence clip by clip, keeping ~2 s of audio scheduled ahead on the AudioContext clock.
// Clips without (ready) audio just advance the schedule by their length, i.e. silence.
async function streamAudio(gen, first) {
  const ctx = S.audioCtx;
  let at = S.t0, buf = first, t = S.pos;
  let ci = S.clips.indexOf(clipAt(t));
  while (S.playing && S.audioGen === gen && ci < S.clips.length) {
    const c = S.clips[ci], local = Math.max(0, t - c.start);
    if (!c.pcm) { at += (c.start + c.dur - t) / 1e6 / S.speed; t = c.start + c.dur; ci++; buf = null; continue; }
    const p = c.pcm, clipFrames = Math.min(p.frames, Math.round((c.dur / 1e6) * p.sampleRate));
    let frame = Math.floor((local / 1e6) * p.sampleRate);
    if (frame >= clipFrames) { at += (c.start + c.dur - t) / 1e6 / S.speed; t = c.start + c.dur; ci++; buf = null; continue; }
    if (!buf) {
      if (at - ctx.currentTime > 2) { await new Promise((r) => setTimeout(r, 150)); continue; }
      buf = await readSegment(c, frame, Math.min(p.sampleRate, clipFrames - frame));
      if (S.audioGen !== gen) break;
      if (!buf) { t = c.start + c.dur; ci++; continue; }
    }
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = S.speed; s.connect(S.gainNode);
    s.start(Math.max(at, ctx.currentTime));
    S.aNodes.push(s); s.onended = () => { S.aNodes = S.aNodes.filter((x) => x !== s); };
    at += buf.length / p.sampleRate / S.speed; t += (buf.length / p.sampleRate) * 1e6; buf = null;
  }
}
async function play() {
  if (!S.meta || S.exporting || S.starting) return;
  const fd = 1e6 / S.meta.fps;
  if (S.pos >= S.outT - fd || S.pos < S.inT) S.pos = S.inT;
  engine.postMessage({ type: 'seek', t: S.pos });
  S.base = S.pos;
  S.aNodes ??= [];
  const gen = S.audioGen = (S.audioGen || 0) + 1;
  S.starting = true;
  await S.audioCtx.resume();
  const c = clipAt(S.pos);
  const first = c?.pcm ? await readSegment(c, Math.floor(((S.pos - c.start) / 1e6) * c.pcm.sampleRate), c.pcm.sampleRate).catch(() => null) : null;
  S.starting = false;
  if (gen !== S.audioGen) return;
  S.t0 = S.audioCtx.currentTime + 0.05;
  S.playing = true;
  streamAudio(gen, first);
  scheduleVoiceovers();
  $('play').textContent = '❚❚'; $('play').setAttribute('aria-label', 'Pause');
}
function pause() {
  if (!S.playing) return;
  S.pos = clockNow(); S.playing = false;
  S.audioGen = (S.audioGen || 0) + 1;
  for (const n of S.aNodes || []) { try { n.stop(); } catch {} }
  S.aNodes = [];
  for (const n of S.voNodes) { try { n.stop(); } catch {} }
  S.voNodes = [];
  if (S.gainNode) { S.gainNode.gain.cancelScheduledValues(0); S.gainNode.gain.value = +$('gain').value; }
  if (S.rec && !S.rec.stopping) stopRecording();
  S.node = null; $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play');
}
let pendingSeek = null, n = 0;
function tick() {
  renderVoList();
requestAnimationFrame(tick);
  if (!S.meta || S.exporting || S.busy) return;
  if (pendingSeek !== null) { engine.postMessage({ type: 'seek', t: pendingSeek }); pendingSeek = null; }
  let t = clockNow();
  if (S.playing && t >= S.outT) { pause(); S.pos = S.outT; t = S.outT; }
  engine.postMessage({ type: 'frame', t, fx: fx(), playing: S.playing });
  $('tc').textContent = `${fmt(t)} / ${fmt(S.dur)}`;
  positionPlayhead(t);
  if (++n % 15 === 0) updateStats();
}

// ---------------------------------------------------------------- Timeline UI
function laneBox() { const l = document.querySelector('.lane').getBoundingClientRect(), r = $('timeline').getBoundingClientRect(); return { x: l.left - r.left, w: l.width, abs: l.left }; }
const tToX = (t) => { const b = laneBox(); return b.x + (t / S.dur) * b.w; };
function positionPlayhead(t) { if (S.dur) $('playhead').style.left = tToX(t) + 'px'; }
function layoutTimeline() {
  if (!S.dur) { $('v1Lane').innerHTML = ''; $('titleBar').style.display = 'none'; return; }
  const b = laneBox();
  $('range').style.left = tToX(S.inT) + 'px'; $('range').style.width = ((S.outT - S.inT) / S.dur) * b.w + 'px';
  const ti = fx().title, bar = $('titleBar');
  const s = Math.max(0, ti.start * 1e6), e = Math.min(S.dur, ti.end * 1e6);
  bar.style.display = ti.text && e > s ? 'flex' : 'none';
  bar.style.left = (s / S.dur) * 100 + '%'; bar.style.width = ((e - s) / S.dur) * 100 + '%';
  bar.textContent = ti.text;
  // V1: one segment per clip, butted end to end
  const lane = $('v1Lane'), fd = S.clips.length > 1 ? +$('fade').value * 1e6 / 2 : 0;
  lane.innerHTML = S.clips.map((c, i) => `<div class="clip video${i % 2 ? ' alt' : ''}" style="left:${(c.start / S.dur) * 100}%;width:${(c.dur / S.dur) * 100}%" title="${c.name}">${c.name}</div>`).join('') + (fd ? S.clips.slice(1).map((c) => `<div class="fade-mark" style="left:${((c.start - fd) / S.dur) * 100}%;width:${((2 * fd) / S.dur) * 100}%" title="Fade"></div>`).join('') : '');
  layoutVoLane();
}
function drawWave() {
  const c = $('wave'), r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
  if (!S.dur) return;
  const mid = c.height / 2, col = getComputedStyle(document.documentElement).getPropertyValue('--wave');
  g.font = `${10 * dpr}px monospace`;
  // Peaks were computed in the worker while decoding, so no PCM loads here
  for (const cl of S.clips) {
    const x0 = Math.round((cl.start / S.dur) * c.width), x1 = Math.round(((cl.start + cl.dur) / S.dur) * c.width);
    if (!cl.pcm) { g.fillStyle = '#555'; g.fillText(cl.hasAudio ? 'audio: ' + (cl.audioStatus || '…') : 'no audio', x0 + 6 * dpr, 16 * dpr, Math.max(10, x1 - x0 - 8 * dpr)); continue; }
    const pk = cl.pcm.peaks, used = Math.min(pk.length, Math.ceil(pk.length * (cl.pcm.frames / cl.pcm.sampleRate) / (cl.dur / 1e6)));
    g.fillStyle = col;
    for (let x = x0; x < x1; x++) { const b = Math.floor(((x - x0) / (x1 - x0)) * used), h = Math.max(1, (pk[b] || 0) * mid); g.fillRect(x, mid - h, 1, h * 2); }
    if (x0 > 0) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x0, 0, Math.max(1, dpr), c.height); }
  }
}
// Clip list in the panel: reorder / remove
function renderClipList() {
  const el = $('clipList'); if (!el) return;
  if (!S.clips.length) { el.innerHTML = '<p class="muted small">No clips yet. Open a video, then use Add video to append more.</p>'; return; }
  el.innerHTML = S.clips.map((c, i) => `<div class="clip-row">
    <span class="clip-idx mono">${i + 1}</span>
    <span class="clip-name" title="${c.name}">${c.name}<small class="mono">${fmt(c.dur)} · ${c.width}×${c.height}${c.rotation ? ' · ' + c.rotation + '°' : ''}</small></span>
    <button class="btn small" data-a="up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${c.name} earlier">↑</button>
    <button class="btn small" data-a="down" data-id="${c.id}" ${i === S.clips.length - 1 ? 'disabled' : ''} aria-label="Move ${c.name} later">↓</button>
    <button class="btn small" data-a="rm" data-id="${c.id}" aria-label="Remove ${c.name}">✕</button></div>`).join('');
}
$('fade').addEventListener('input', () => { $('fadeVal').textContent = (+$('fade').value).toFixed(1) + ' s'; layoutTimeline(); if (!S.playing) engine.postMessage({ type: 'frame', t: S.pos, fx: fx(), playing: false }); });
$('clipList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]'); if (!b || S.exporting || S.busy) return;
  pause();
  const id = +b.dataset.id;
  if (b.dataset.a === 'rm') engine.postMessage({ type: 'removeClip', id });
  else engine.postMessage({ type: 'moveClip', id, dir: b.dataset.a === 'up' ? -1 : 1 });
});
function scrubAt(clientX) {
  const b = laneBox();
  const t = Math.min(S.dur - 1, Math.max(0, ((clientX - b.abs) / b.w) * S.dur));
  pause(); pendingSeek = t; S.pos = t;
}
$('timeline').addEventListener('pointerdown', (e) => {
  if (!S.meta || S.exporting || S.busy) return;
  scrubAt(e.clientX);
  const mv = (ev) => scrubAt(ev.clientX), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
});
addEventListener('resize', () => { drawWave(); layoutTimeline(); });
for (const id of ['titleText', 'titleStart', 'titleEnd']) $(id).addEventListener('input', layoutTimeline);
$('gain').addEventListener('input', () => { if (S.gainNode) S.gainNode.gain.value = +$('gain').value; });
$('rotate').onclick = () => { if (!S.meta || S.exporting) return; pause(); engine.postMessage({ type: 'rotate', t: S.pos }); };
$('play').onclick = () => (S.playing ? pause() : play());
$('setIn').onclick = () => { S.inT = Math.min(clockNow(), S.outT - 1e5); layoutTimeline(); };
$('setOut').onclick = () => { S.outT = Math.max(clockNow(), S.inT + 1e5); layoutTimeline(); };
addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text],input[type=number],select') || !S.meta) return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (e.key === 'i') $('setIn').click();
  else if (e.key === 'o') $('setOut').click();
});

function updateStats() {
  if (!S.meta || !S.clips.length) { $('stats').innerHTML = ''; return; }
  const st = S.stats;
  const cc = S.clips.find((c) => c.id === st.clipId) || clipAt(S.pos) || S.clips[0];
  const m = { ...S.meta, ...(cc.meta || {}) };
  const rot = { rotation: cc.rotation, width: cc.width, height: cc.height };
  const rows = [
    ['Clips', `${S.clips.length} · now ${S.clips.indexOf(cc) + 1}: ${cc.name}`], ['Sequence', fmt(S.dur)], ['Pipeline', cc.pipeline || S.pipeline], ['Codec', m.codec], ['Size', `${m.width}×${m.height} → ${rot.width}×${rot.height}`], ['Output', S.rot ? `${S.rot.width}×${S.rot.height} @ ${S.meta.fps} fps` : ''], ['Rotation', `${m.rotation}° tag` + (rot.rotation !== m.rotation ? `, ${rot.rotation}° applied` : '')], ['FPS', m.fps],
    ['Samples', `${m.samples} (${m.keyframes} key)`], ['Audio', cc.pcm ? `${cc.pcm.channels}ch @ ${cc.pcm.sampleRate / 1000}kHz, ${cc.audioStatus}` : (cc.audioStatus || 'none')],
    ['Source', `${(S.clips.reduce((a, c) => a + (c.meta?.fileSize || 0), 0) / 1e6).toFixed(1)} MB on disk · ${((st.diskRead ?? 0) / 1e6).toFixed(1)} MB read`],
    ['Storage', S.storage || '…'],
    ['Threads', 'UI · engine' + (ffWorker ? ' · ffmpeg' : '')], ['Decoders', `${st.decoders ?? 0} live`],
    ['Decode queue', st.decodeQueue ?? 0], ['Frame queue', st.queue ?? 0],
    ['Decoded', st.decoded ?? 0], ['Seek-skipped', st.dropped ?? 0], ['Late ticks', st.late ?? 0],
    ['Trim', `${fmt(S.inT)} → ${fmt(S.outT)}`], ['Voice-over', `${S.vo.length} clip(s)`], ['Speed', `${S.speed}× → ${fmt((S.outT - S.inT) / S.speed)} out`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd title="${v}">${v}</dd>`).join('');
}

function setSpeed(v) {
  const was = S.playing; if (was) pause();
  S.speed = v; $('speed').value = String(v); updateStats(); layoutTimeline();
  if (was) play();
}
$('speed').addEventListener('change', (e) => setSpeed(+e.target.value));
addEventListener('keydown', (e) => {
  if (e.target.matches('input,select') || !S.meta) return;
  const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4], i = steps.indexOf(S.speed);
  if (e.key === ']' && i < steps.length - 1) setSpeed(steps[i + 1]);
  if (e.key === '[' && i > 0) setSpeed(steps[i - 1]);
});


// ---------------------------------------------------------------- Voice-over
// Clips are anchored at a source-time position and play at real speed (1×) from the output moment
// the playhead reaches them, so narration never gets chipmunked by the speed setting.
const voOutStart = (c) => (c.start - S.inT) / S.speed / 1e6; // seconds on the output timeline
function scheduleVoiceovers() {
  const ctx = S.audioCtx; if (!ctx) return;
  if (!S.voBus) { S.voBus = ctx.createGain(); S.voBus.connect(ctx.destination); }
  S.voBus.gain.value = +$('voGain').value;
  const t0 = S.t0;
  const duck = +$('duck').value, g = S.gainNode?.gain, base = +$('gain').value;
  g?.cancelScheduledValues(0); if (g) g.setValueAtTime(base, ctx.currentTime);
  for (const c of S.vo) {
    if (c.muted) continue;
    const delay = (c.start - S.pos) / S.speed / 1e6; // seconds from now (output time)
    const offset = Math.max(0, -delay);
    if (offset >= c.buffer.duration) continue;
    const src = ctx.createBufferSource(); src.buffer = c.buffer; src.connect(S.voBus);
    const at = t0 + Math.max(0, delay);
    src.start(at, offset); S.voNodes.push(src);
    if (g && duck < 1) { // duck the clip audio under the voice with short ramps
      const end = at + (c.buffer.duration - offset);
      g.setValueAtTime(base, Math.max(ctx.currentTime, at - 0.15));
      g.linearRampToValueAtTime(base * duck, at);
      g.setValueAtTime(base * duck, end);
      g.linearRampToValueAtTime(base, end + 0.2);
    }
  }
}

async function startRecording() {
  if (!S.meta || S.exporting || S.busy) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { toast('Microphone access was blocked: ' + e.message); return; }
  S.audioCtx ??= new AudioContext({ sampleRate: 48000 });
  await S.audioCtx.resume();
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const chunks = [];
  const start = S.pos;
  S.rec = { mr, stream, start, chunks, stopping: false, began: performance.now() };
  const rec = S.rec;
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    try {
      const buf = await new Blob(chunks, { type: mr.mimeType }).arrayBuffer();
      let audio = await S.audioCtx.decodeAudioData(buf);
      window.__voDebug = { wall: (performance.now() - rec.began) / 1000, decoded: audio.duration };
      S.vo.push({ id: crypto.randomUUID(), start, buffer: audio, muted: false });
      S.vo.sort((a, b) => a.start - b.start);
      renderVoList(); layoutTimeline();
    } catch (e) { toast('Could not decode recording: ' + e.message); }
    S.rec = null; $('rec').classList.remove('recording'); $('rec').textContent = '● Record voice-over';
  };
  mr.start(250);
  $('rec').classList.add('recording'); $('rec').textContent = '■ Stop recording';
  if ($('recMute').checked && S.gainNode) S.gainNode.gain.value = 0;
  play(); // narrate while the video plays from the playhead
  if ($('recMute').checked && S.gainNode) { S.gainNode.gain.cancelScheduledValues(0); S.gainNode.gain.value = 0; }
}
function stopRecording() { if (!S.rec || S.rec.stopping) return; S.rec.stopping = true; S.rec.mr.stop(); if (S.playing) pause(); }
$('rec').onclick = () => (S.rec ? stopRecording() : startRecording());
async function importVoice(file) {
  if (!S.meta) return;
  S.audioCtx ??= new AudioContext({ sampleRate: 48000 });
  try {
    const audio = await S.audioCtx.decodeAudioData(await file.arrayBuffer());
    S.vo.push({ id: crypto.randomUUID(), start: S.pos, buffer: audio, muted: false, name: file.name });
    S.vo.sort((a, b) => a.start - b.start); renderVoList(); layoutTimeline();
  } catch (e) { toast('Could not read audio file: ' + e.message); }
}
$('voFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importVoice(f); e.target.value = ''; });
function renderVoList() {
  const ul = $('voList');
  ul.innerHTML = S.vo.length ? '' : '<li class="muted small">No voice-over clips yet. Move the playhead, then record.</li>';
  S.vo.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mono small">VO ${i + 1} · ${fmt(c.start)} · ${c.buffer.duration.toFixed(1)}s</span>
      <span><button class="btn small" data-a="here" title="Move to playhead">⇤</button>
      <button class="btn small" data-a="mute">${c.muted ? 'Unmute' : 'Mute'}</button>
      <button class="btn small" data-a="del" aria-label="Delete">✕</button></span>`;
    li.onclick = (e) => {
      const a = e.target.dataset.a; if (!a) return;
      pause();
      if (a === 'del') S.vo = S.vo.filter((x) => x !== c);
      if (a === 'mute') c.muted = !c.muted;
      if (a === 'here') { c.start = S.pos; S.vo.sort((x, y) => x.start - y.start); }
      renderVoList(); layoutTimeline();
    };
    ul.appendChild(li);
  });
  window.__vo = S.vo.length;
}
function layoutVoLane() {
  const lane = $('voLane'); lane.innerHTML = '';
  if (!S.dur) return;
  for (const c of S.vo) {
    const d = document.createElement('div'); d.className = 'clip vo' + (c.muted ? ' muted' : '');
    const lenSrc = c.buffer.duration * 1e6 * S.speed; // occupies this much source time at current speed
    d.style.left = (c.start / S.dur) * 100 + '%';
    d.style.width = Math.max(0.5, (Math.min(lenSrc, S.dur - c.start) / S.dur) * 100) + '%';
    d.textContent = 'VO'; lane.appendChild(d);
  }
}
// Mix voice-over into the export's output-timeline PCM (with ducking)
function mixVoiceovers(audio, outLen) {
  const clips = S.vo.filter((c) => !c.muted); if (!clips.length) return audio;
  const sr = 48000;
  if (!audio) audio = { sampleRate: sr, channels: [new Float32Array(outLen), new Float32Array(outLen)] };
  const rate = audio.sampleRate, ch = audio.channels.length, len = audio.channels[0].length;
  const duck = +$('duck').value, vg = +$('voGain').value / (+$('gain').value || 1); // engine multiplies by gain later
  const env = new Float32Array(len).fill(1), ramp = Math.round(0.15 * rate);
  for (const c of clips) {
    const s = Math.round(voOutStart(c) * rate), n = Math.round(c.buffer.duration * rate);
    for (let i = Math.max(0, s - ramp); i < Math.min(len, s + n + ramp); i++) {
      const k = i < s ? 1 - (i - (s - ramp)) / ramp : i >= s + n ? (i - (s + n)) / ramp : 0;
      env[i] = Math.min(env[i], duck + (1 - duck) * k);
    }
  }
  for (let c = 0; c < ch; c++) { const p = audio.channels[c]; for (let i = 0; i < len; i++) p[i] *= env[i]; }
  for (const c of clips) {
    const s = Math.round(voOutStart(c) * rate), b = c.buffer, ratio = b.sampleRate / rate;
    for (let k = 0; k < ch; k++) {
      const src = b.getChannelData(Math.min(k, b.numberOfChannels - 1)), dst = audio.channels[k];
      for (let i = Math.max(0, -s); s + i < len; i++) { const x = Math.floor(i * ratio); if (x >= src.length) break; dst[s + i] += src[x] * vg; }
    }
  }
  return audio;
}

// ---------------------------------------------------------------- Export
function showExportBox() { $('exportBox').hidden = false; }
function setStatus(msg) { $('exportMsg').textContent = msg; }
function setProgress(p) { $('bar').style.width = Math.max(0, Math.min(100, p)) + '%'; }
function setBusy(b) { for (const id of ['demo', 'export']) $(id).disabled = b || (id === 'export' && !S.meta); $('fileLabel').classList.toggle('disabled', b); $('addLabel').classList.toggle('disabled', b || !S.clips.length); }

let exportStarted = 0;
function exportVideo() {
  if (!S.meta || S.exporting || S.busy) return;
  const waiting = S.clips.filter((c) => c.hasAudio && !c.pcm && !/unsupported|cleared/.test(c.audioStatus || ''));
  if (waiting.length) { toast(`Audio is still being decoded to disk for ${waiting.map((c) => c.name).join(', ')}. Try again in a moment.`); return; }
  pause(); S.exporting = true; setBusy(true);
  showExportBox();
  // On phones the progress box sits far below the header button; bring it into view
  if (matchMedia('(max-width:860px)').matches) $('exportBox').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('download').hidden = true; $('result').hidden = true; setProgress(0);
  exportStarted = performance.now();
  // Audio is mixed in the worker, streaming from the OPFS PCM cache; only small voice-over clips are sent
  const vo = S.vo.filter((c) => !c.muted).map((c) => ({ start: c.start, sampleRate: c.buffer.sampleRate,
    channels: Array.from({ length: Math.min(2, c.buffer.numberOfChannels) }, (_, k) => c.buffer.getChannelData(k).slice()) }));
  engine.postMessage({ type: 'export', inT: S.inT, outT: S.outT, fx: fx(), gain: +$('gain').value, speed: S.speed,
    vo, duck: +$('duck').value, voGain: +$('voGain').value }, vo.flatMap((c) => c.channels.map((x) => x.buffer)));
}
async function onExported(m) {
  const fmtSel = $('format').value;
  let ext = 'mp4', note = 'mp4-muxer → OPFS';
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
    let outFile = await (await dir.getFileHandle(m.name)).getFile(); // disk-backed, not in memory
    if (fmtSel !== 'mp4') {
      setStatus(`Muxing to ${fmtSel.toUpperCase()} with FFmpeg.wasm…`); setProgress(0);
      const aArgs = fmtSel === 'mov' && m.audio === 'Opus' ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'] : ['-c', 'copy'];
      const r = await ffmpeg({ name: 'in.mp4', file: outFile }, ['-i', 'in.mp4', ...aArgs, `out.${fmtSel}`], `out.${fmtSel}`, `mux → ${fmtSel}`);
      ext = fmtSel; note = 'FFmpeg.wasm mux';
      const fh = await dir.getFileHandle(`export.${ext}`, { create: true }); const w = await fh.createWritable(); await w.write(r.data); await w.close();
      outFile = await fh.getFile();
    }
    const blob = outFile;
    if (S.lastUrl) URL.revokeObjectURL(S.lastUrl);
    const url = S.lastUrl = URL.createObjectURL(blob);
    setProgress(100);
    const secs = ((performance.now() - exportStarted) / 1000).toFixed(1);
    setStatus(`Done: ${m.frames} frames, ${(blob.size / 1e6).toFixed(2)} MB, ${m.labels} → ${ext.toUpperCase()} (${note}) in ${secs}s`);
    $('download').href = url; $('download').download = `framewright-export.${ext}`; $('download').textContent = `Download ${ext.toUpperCase()}`; $('download').hidden = false;
    if (ext !== 'mkv') { $('result').src = url; $('result').hidden = false; }
    refreshStorage();
    window.__lastExport = { size: blob.size, frames: m.frames, video: m.video, audio: m.audio, format: ext };
  } catch (e) { onExportError(e.message); return; }
  finishExport();
}
function onExportError(msg) { toast('Export failed: ' + msg); setStatus('Export failed: ' + msg); window.__lastExport = { error: msg }; finishExport(); }
function finishExport() { S.exporting = false; setBusy(false); engine.postMessage({ type: 'seek', t: S.pos }); }
$('export').onclick = exportVideo;

// ---------------------------------------------------------------- Boot
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
// Add video: append one or more files to the end of the sequence, in the order picked
$('addFile').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) { while (S.busy) await new Promise((r) => setTimeout(r, 100)); await loadFile(f, f.name, true); }
});
const fileFromUrl = async (u) => { const name = u.split('/').pop(); const b = await (await fetch(u)).blob(); return new File([b], name, { type: b.type, lastModified: 1 }); };
$('demo').onclick = async () => {
  try { loadFile(await fileFromUrl('sample.mp4')); }
  catch (e) { toast('Could not load demo: ' + e.message); }
};
$('clearStorage').onclick = () => { if (S.exporting) return; pause(); for (const c of S.clips) { c.pcm = null; c.pcmFile = null; if (c.hasAudio) c.audioStatus = 'cleared (reopen the videos to restore audio)'; } drawWave(); updateStats(); engine.postMessage({ type: 'clearStorage' }); };
window.__loadUrl = async (u, append) => loadFile(await fileFromUrl(u), undefined, append);
renderVoList();
requestAnimationFrame(tick);
