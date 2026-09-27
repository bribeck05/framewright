// FFmpeg.wasm worker — single-threaded core (no SharedArrayBuffer / COOP+COEP required).
// Loaded lazily; used only when WebCodecs/mp4box can't handle a file, or for MOV/MKV muxing.
let core = null;
let logs = [];

async function load() {
  if (core) return core;
  // Fetched from a CDN at runtime (not bundled): @ffmpeg/core is a GPL build, the rest of the app is MIT
  const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  const coreURL = `${CORE}/ffmpeg-core.js`, wasmURL = `${CORE}/ffmpeg-core.wasm`;
  post({ type: 'status', msg: 'Loading FFmpeg.wasm core (~32 MB, cached after first use)…' });
  const { default: createFFmpegCore } = await import(coreURL);
  core = await createFFmpegCore({ mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}` });
  core.setLogger(({ message }) => { logs.push(message); if (logs.length > 200) logs.shift(); });
  core.setProgress(({ progress }) => post({ type: 'progress', progress: Math.max(0, Math.min(1, progress)) }));
  return core;
}
const post = (m, t) => self.postMessage(m, t || []);

// job: { id, input: {name, file?:File, data?:ArrayBuffer}, args:[...], output:'out.mp4' }
self.onmessage = async ({ data: job }) => {
  const started = performance.now();
  try {
    const ff = await load();
    logs = [];
    let mount = null;
    if (job.input.file) {
      // WORKERFS: FFmpeg reads the File lazily from disk instead of copying it into wasm memory
      mount = `/in${job.id}`;
      ff.FS.mkdir(mount);
      ff.FS.mount(ff.FS.filesystems.WORKERFS, { files: [new File([job.input.file], job.input.name)] }, mount);
      job.args = job.args.map((a) => (a === job.input.name ? `${mount}/${job.input.name}` : a));
    } else ff.FS.writeFile(job.input.name, new Uint8Array(job.input.data));
    post({ type: 'status', msg: `ffmpeg ${job.args.join(' ')}` });
    ff.setTimeout(-1);
    ff.exec(...job.args);
    const ret = ff.ret;
    ff.reset();
    if (mount) { try { ff.FS.unmount(mount); ff.FS.rmdir(mount); } catch {} }
    else { try { ff.FS.unlink(job.input.name); } catch {} }
    if (ret !== 0) throw new Error(`ffmpeg exited with ${ret}: ${logs.slice(-4).join(' | ')}`);
    const out = ff.FS.readFile(job.output);
    ff.FS.unlink(job.output);
    post({ type: 'done', id: job.id, data: out.buffer, ms: performance.now() - started, logs: logs.slice(-12) }, [out.buffer]);
  } catch (e) {
    post({ type: 'error', id: job.id, message: e.message || String(e), logs: logs.slice(-12) });
  }
};
