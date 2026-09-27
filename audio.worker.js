// Audio worker: compressed track → AudioDecoder → interleaved f32 PCM in OPFS (+ waveform peaks).
// Reads each packet straight from the disk-backed File, so memory stays flat for any file length.
const yc = new MessageChannel(), yq = [];
yc.port1.onmessage = () => yq.shift()?.();
const yieldNow = () => new Promise((r) => { yq.push(r); yc.port2.postMessage(0); });
const drained = (codec) => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; codec.addEventListener?.('dequeue', f, { once: true }); yieldNow().then(() => setTimeout(f, 50)); });

self.onmessage = async ({ data: { file, samples, cfg, key, estSec, outCh } }) => {
  let h;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('cache', { create: true });
    h = await (await dir.getFileHandle(key + '.f32', { create: true })).createSyncAccessHandle();
    h.truncate(0);
    const reader = new FileReaderSync();
    const BINS = 2000, peaks = new Float32Array(BINS);
    let written = 0, sr = 0, binSize = 1, err = null;
    const dec = new AudioDecoder({
      output: (ad) => {
        if (!sr) { sr = ad.sampleRate; binSize = Math.max(1, Math.ceil((estSec * sr) / BINS)); }
        const n = ad.numberOfFrames, inter = new Float32Array(n * outCh), plane = new Float32Array(n);
        for (let c = 0; c < outCh; c++) {
          ad.copyTo(plane, { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: 'f32-planar' });
          for (let i = 0; i < n; i++) inter[i * outCh + c] = plane[i];
        }
        for (let i = 0; i < n; i++) { const b = Math.min(BINS - 1, Math.floor((written + i) / binSize)), v = Math.abs(inter[i * outCh]); if (v > peaks[b]) peaks[b] = v; }
        h.write(inter, { at: written * outCh * 4 });
        written += n; ad.close();
      },
      error: (e) => (err = e),
    });
    dec.configure(cfg);
    for (let i = 0; i < samples.length; i++) {
      const [offset, size, cts, duration, ts] = samples[i];
      const data = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + size)));
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((cts * 1e6) / ts), duration: Math.round((duration * 1e6) / ts), data }));
      while (dec.decodeQueueSize > 16) await drained(dec);
      if (err) throw err;
      if (i % 50 === 0) { self.postMessage({ type: 'progress', pct: (i / samples.length) * 100 }); await yieldNow(); }
    }
    await dec.flush();
    if (err) throw err;
    h.flush(); h.close(); h = null;
    self.postMessage({ type: 'done', meta: { key, sampleRate: sr, channels: outCh, frames: written, peaks: Array.from(peaks), complete: true } });
  } catch (e) {
    try { h?.close(); } catch {}
    self.postMessage({ type: 'error', message: e.message || String(e) });
  }
};
