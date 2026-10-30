// 무음 카메라: getUserMedia 영상 프레임을 canvas로 캡처하므로 셔터음이 나지 않습니다.
const $ = id => document.getElementById(id);
const preview = $('preview');
let stream = null, facing = 'environment', timer = 0, busy = false;
let stabilizer = null, recorder = null, rawRecorder = null, recStart = 0, recTick = null, micStream = null;
let wakeLock = null;
const native = window.AndroidBridge; // 안드로이드 앱(APK)에서만 존재

// ---------- 설정 (이 기기에 기억) ----------
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} }
};
let hideRec = store.get('hideRec', false);   // 촬영 중 표시(빨간 시간/버튼 변화) 숨기기
let stab = store.get('stab', true);          // 영상 손떨림 보정
let autoSave = store.get('autoSaveV2', false); // 촬영 즉시 기기에 저장 (기본: 끔, 갤러리에서 '저장'을 눌러야 저장)

// ---------- 저장소 (IndexedDB) ----------
const dbReady = new Promise((res, rej) => {
  const r = indexedDB.open('silent-camera', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await dbReady;
  return new Promise((res, rej) => {
    const t = db.transaction('photos', mode), s = t.objectStore('photos');
    const req = fn(s);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
};
const addItem = (blob, type, tag = '') => {
  if (autoSave) { if (native) saveNative(blob, type, tag).catch(() => {}); else downloadBlob(blob, type, tag); }
  return tx('readwrite', s => s.add({ blob, type, tag, time: Date.now() }));
};
// 웹: 촬영 즉시 파일로 내려받아 저장 (안드로이드는 다운로드 폴더, 아이폰은 파일 앱/저장 확인창)
function downloadBlob(blob, type, tag = '') {
  const isPhoto = type === 'photo';
  const ext = isPhoto ? 'jpg' : ((blob.type || '').includes('mp4') ? 'mp4' : 'webm');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'silent-' + new Date().toISOString().replace(/[:.]/g, '-') + (tag === 'original' ? '-original' : '') + '.' + ext;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
// 앱에서는 촬영물을 기기 갤러리에도 자동 저장
async function saveNative(blob, type, tag = '') {
  const ext = type === 'photo' ? 'jpg' : ((blob.type || '').includes('mp4') ? 'mp4' : 'webm');
  const name = 'silent-' + new Date().toISOString().replace(/[:.]/g, '-') + (tag === 'original' ? '-original' : '') + '.' + ext;
  const id = native.saveBegin(name, blob.type || 'image/jpeg', type);
  if (!id) return;
  const CH = 768 * 1024; // 3의 배수 → base64 조각을 독립적으로 디코드 가능
  for (let o = 0; o < blob.size; o += CH) {
    const b64 = await new Promise(r => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result.split(',')[1]);
      fr.readAsDataURL(blob.slice(o, o + CH));
    });
    native.saveChunk(id, b64);
  }
  native.saveEnd(id);
}
const allItems = () => tx('readonly', s => s.getAll()).then(a => a.reverse());
const delItem = id => tx('readwrite', s => s.delete(id));
const clearItems = () => tx('readwrite', s => s.clear());
const isVideo = p => p.type === 'video' || (p.blob.type || '').startsWith('video');
const extOf = p => isVideo(p) ? ((p.blob.type || '').includes('mp4') ? 'mp4' : 'webm') : 'jpg';

// ---------- 카메라 ----------
function showMessage(text) { const m = $('message'); m.textContent = text; m.hidden = false; }

async function startCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    preview.srcObject = stream;
    preview.classList.toggle('front', facing === 'user');
    $('message').hidden = true;
  } catch (e) {
    showMessage('카메라를 사용할 수 없습니다.\n브라우저의 카메라 권한을 허용하고 HTTPS(또는 localhost)로 접속해 주세요.');
  }
}

async function capture() {
  if (busy || !stream || !preview.videoWidth) return;
  busy = true;
  const c = document.createElement('canvas');
  c.width = preview.videoWidth; c.height = preview.videoHeight;
  const ctx = c.getContext('2d');
  if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(preview, 0, 0);
  if ($('stealth').hidden) { const f = $('flash'); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  await addItem(blob, 'photo');
  await refreshThumb();
  busy = false;
}

async function shoot() {
  if (!timer) return capture();
  const cd = $('countdown');
  if ($('stealth').hidden) cd.hidden = false;
  for (let n = timer; n > 0; n--) { cd.textContent = n; await new Promise(r => setTimeout(r, 1000)); }
  cd.hidden = true;
  capture();
}

// ---------- 영상 손떨림 보정 (소프트웨어) ----------
// 프레임마다 작은 흑백 이미지로 이전 프레임 대비 이동량을 구하고, 누적 경로를 부드럽게 만든 뒤
// 그 차이만큼 화면을 반대로 밀어서 canvas 에 그립니다. 가장자리가 비지 않게 12% 확대합니다.
function startStabilizer() {
  const vw = preview.videoWidth, vh = preview.videoHeight;
  const sc = Math.min(1, 1280 / vw);
  const W = Math.round(vw * sc), H = Math.round(vh * sc);
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const SW = 160, SH = Math.max(40, Math.round(SW * vh / vw)), K = W / SW;
  const small = document.createElement('canvas'); small.width = SW; small.height = SH;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const R = 8, N = 2 * R + 1, ZOOM = 1.12, A = 0.08;
  const MAXX = W * (ZOOM - 1) / 2, MAXY = H * (ZOOM - 1) / 2;
  const sad = new Float32Array(N * N);
  let prev = null, Cx = 0, Cy = 0, Sx = 0, Sy = 0, running = true;

  const gray = () => {
    sctx.drawImage(preview, 0, 0, SW, SH);
    const d = sctx.getImageData(0, 0, SW, SH).data, g = new Uint8Array(SW * SH);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return g;
  };
  const sub = (a, b, c) => { const den = a - 2 * b + c; return den > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0; };
  const estimate = (p, c) => {
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let t = 0;
      for (let y = R; y < SH - R; y++) {
        const row = y * SW, prow = (y - dy) * SW - dx;
        for (let x = R; x < SW - R; x++) t += Math.abs(c[row + x] - p[prow + x]);
      }
      sad[(dy + R) * N + dx + R] = t;
      if (t < best) { best = t; bx = dx; by = dy; }
    }
    let fx = bx, fy = by;
    if (Math.abs(bx) < R) fx += sub(sad[(by + R) * N + bx - 1 + R], best, sad[(by + R) * N + bx + 1 + R]);
    if (Math.abs(by) < R) fy += sub(sad[(by - 1 + R) * N + bx + R], best, sad[(by + 1 + R) * N + bx + R]);
    return [fx, fy];
  };
  const frame = () => {
    if (!running) return;
    if (preview.videoWidth) {
      const g = gray();
      if (prev) { const [dx, dy] = estimate(prev, g); Cx += dx * K; Cy += dy * K; }
      prev = g;
      Sx += A * (Cx - Sx); Sy += A * (Cy - Sy);
      let tx = Sx - Cx, ty = Sy - Cy;
      const cx = Math.max(-MAXX, Math.min(MAXX, tx)), cy = Math.max(-MAXY, Math.min(MAXY, ty));
      if (cx !== tx) Sx = Cx + cx; // 보정 한계를 넘으면 경로를 따라감 (큰 이동은 의도한 움직임)
      if (cy !== ty) Sy = Cy + cy;
      octx.setTransform(ZOOM, 0, 0, ZOOM, W / 2 * (1 - ZOOM) + cx, H / 2 * (1 - ZOOM) + cy);
      octx.drawImage(preview, 0, 0, W, H);
    }
    schedule();
  };
  const schedule = () => preview.requestVideoFrameCallback ? preview.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  schedule();
  const track = out.captureStream(30).getVideoTracks()[0];
  return { track, stop() { running = false; track.stop(); } };
}

// ---------- 영상 촬영 ----------
async function toggleRecord() {
  if (recorder) return stopRecord();
  if (!stream) return;
  let tracks = [...stream.getVideoTracks()];
  const rawVideo = [...tracks];
  if (stab && HTMLCanvasElement.prototype.captureStream && preview.videoWidth) {
    try { stabilizer = startStabilizer(); tracks = [stabilizer.track]; } catch (e) { stabilizer = null; }
  }
  try { // 소리는 마이크 허용 시에만 녹음
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tracks.push(...micStream.getAudioTracks());
  } catch (e) { micStream = null; }
  const types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = window.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t));
  if (!mime) {
    if (stabilizer) { stabilizer.stop(); stabilizer = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    alert('이 브라우저는 영상 촬영을 지원하지 않습니다.'); return;
  }
  const makeRecorder = (recTracks, tag) => {
    const chunks = [];
    const r = new MediaRecorder(new MediaStream(recTracks), { mimeType: mime });
    r.ondataavailable = e => e.data.size && chunks.push(e.data);
    r.onstop = async () => {
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      if (blob.size) await addItem(blob, 'video', tag);
      await refreshThumb();
    };
    return r;
  };
  const audio = micStream ? micStream.getAudioTracks() : [];
  recorder = makeRecorder(tracks, stabilizer ? 'stab' : '');
  // 손떨림 보정이 켜져 있으면 보정 전 원본 영상도 따로 같이 저장
  rawRecorder = stabilizer ? makeRecorder([...rawVideo, ...audio], 'original') : null;
  recorder.start(1000);
  if (rawRecorder) rawRecorder.start(1000);
  recStart = Date.now();
  if (!hideRec) { $('recBtn').classList.add('on'); $('badge').classList.add('rec'); }
  recTick = setInterval(() => {
    if (hideRec) return;
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('badge').textContent = '● ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 500);
}
function stopRecord() {
  if (!recorder) return;
  const r = recorder, raw = rawRecorder, st = stabilizer, mic = micStream;
  recorder = rawRecorder = stabilizer = micStream = null;
  const finish = () => { // 두 녹화가 모두 마무리된 뒤 자원 정리
    if (st) st.stop();
    if (mic) mic.getTracks().forEach(t => t.stop());
  };
  let pending = raw ? 2 : 1;
  const done = () => { if (--pending === 0) finish(); };
  r.addEventListener('stop', done);
  if (raw) raw.addEventListener('stop', done);
  r.stop();
  if (raw) raw.stop();
  clearInterval(recTick);
  $('recBtn').classList.remove('on');
  $('badge').classList.remove('rec');
  $('badge').textContent = '🔇 무음';
}

// ---------- 스텔스 모드 (검은 화면) ----------
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function enterStealth() {
  $('stealth').hidden = false;
  if (native) native.setStealth(true);
  keepAwake();
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}
function exitStealth() {
  $('stealth').hidden = true;
  if (native) native.setStealth(false);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
// 위쪽 절반 터치: 사진 / 아래쪽 절반 터치: 영상 시작·종료 / 1.5초 길게 누르기: 스텔스 해제
(() => {
  const el = $('stealth'); let t = null, long = false;
  el.addEventListener('pointerdown', () => { long = false; t = setTimeout(() => { long = true; exitStealth(); }, 1500); });
  el.addEventListener('pointerup', e => {
    clearTimeout(t);
    if (long) return;
    (e.clientY < innerHeight / 2) ? shoot() : toggleRecord();
  });
  el.addEventListener('pointercancel', () => clearTimeout(t));
  el.addEventListener('contextmenu', e => e.preventDefault());
})();

// ---------- UI ----------
let thumbUrl;
async function refreshThumb() {
  const list = await allItems();
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  const img = $('thumbImg');
  const first = list[0];
  if (first && !isVideo(first)) { thumbUrl = URL.createObjectURL(first.blob); img.src = thumbUrl; }
  else img.removeAttribute('src');
}

let urls = [];
async function openGallery() {
  const list = await allItems();
  urls.forEach(URL.revokeObjectURL); urls = [];
  const grid = $('grid'); grid.innerHTML = '';
  list.forEach(p => {
    const u = URL.createObjectURL(p.blob); urls.push(u);
    const wrap = document.createElement('div'); wrap.className = 'item' + (isVideo(p) ? ' vid' : '');
    let el;
    if (isVideo(p)) { el = document.createElement('video'); el.src = u + '#t=0.1'; el.muted = true; el.preload = 'metadata'; el.playsInline = true; }
    else { el = new Image(); el.src = u; el.alt = '사진'; }
    el.onclick = () => openViewer(p, u);
    wrap.appendChild(el); grid.appendChild(wrap);
  });
  $('empty').hidden = list.length > 0;
  $('gallery').hidden = false;
}
let current;
function openViewer(p, u) {
  current = p;
  const v = isVideo(p);
  $('viewerImg').hidden = v; $('viewerVideo').hidden = !v;
  if (v) $('viewerVideo').src = u; else $('viewerImg').src = u;
  const a = $('viewerSave'); a.href = u;
  a.download = 'silent-' + new Date(p.time).toISOString().replace(/[:.]/g, '-') + (p.tag === 'original' ? '-original' : '') + '.' + extOf(p);
  $('viewer').hidden = false;
}
function closeViewer() { $('viewerVideo').pause(); $('viewer').hidden = true; }

$('shutter').onclick = shoot;
$('recBtn').onclick = toggleRecord;
$('stealthBtn').onclick = enterStealth;
function paintToggles() {
  $('stabBtn').classList.toggle('off', !stab);
  $('hideBtn').classList.toggle('off', !hideRec);
  $('saveBtn').classList.toggle('off', !autoSave);
}
$('stabBtn').onclick = () => { if (recorder) return; stab = !stab; store.set('stab', stab); paintToggles(); };
$('hideBtn').onclick = () => { hideRec = !hideRec; store.set('hideRec', hideRec); paintToggles(); };
$('saveBtn').onclick = () => { autoSave = !autoSave; store.set('autoSaveV2', autoSave); paintToggles(); };
paintToggles();
$('flipBtn').onclick = () => { if (recorder) return; facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('timerBtn').onclick = () => {
  timer = timer === 0 ? 3 : timer === 3 ? 10 : 0;
  $('timerLabel').textContent = timer ? timer + '초' : '끔';
};
$('thumb').onclick = $('galleryBtn').onclick = openGallery;
$('closeGallery').onclick = () => { $('gallery').hidden = true; refreshThumb(); };
$('viewerClose').onclick = closeViewer;
$('viewerDelete').onclick = async () => {
  if (!confirm('삭제할까요?')) return;
  await delItem(current.id); closeViewer(); openGallery();
};
$('clearAll').onclick = async () => {
  if (confirm('모두 삭제할까요?')) { await clearItems(); openGallery(); }
};
// 앱(APK)에서 볼륨 버튼이 눌리면 네이티브가 호출: 업=사진, 다운=영상
window.nativeKey = k => {
  if (!$('gallery').hidden || !$('viewer').hidden) return;
  k === 'up' ? shoot() : toggleRecord();
};
// 앱(APK)에서는 '저장'을 누르면 기기 갤러리에 저장
$('viewerSave').onclick = e => {
  if (!native || !current) return;
  e.preventDefault();
  saveNative(current.blob, isVideo(current) ? 'video' : 'photo', current.tag || '').then(() => alert('갤러리에 저장했습니다.'));
};
// 볼륨 업: 사진 / 볼륨 다운: 영상 (※ 브라우저가 볼륨 키를 전달하는 기기에서만 동작)
document.addEventListener('keydown', e => {
  const camera = $('gallery').hidden && $('viewer').hidden;
  if (!camera) return;
  if (e.key === 'AudioVolumeUp' || e.key === 'VolumeUp') { e.preventDefault(); shoot(); }
  else if (e.key === 'AudioVolumeDown' || e.key === 'VolumeDown') { e.preventDefault(); toggleRecord(); }
  else if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); shoot(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!stream?.active) startCamera();
  if (!$('stealth').hidden) keepAwake();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refreshThumb();
startCamera();
