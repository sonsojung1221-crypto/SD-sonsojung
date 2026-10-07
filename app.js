// 무음 카메라: getUserMedia 영상 프레임을 canvas로 캡처하므로 셔터음이 나지 않습니다.
const $ = id => document.getElementById(id);
const preview = $('preview');
let stream = null, facing = 'environment', timer = 0, busy = false;
let recorder = null, recChunks = [], recStart = 0, recTick = null, micStream = null;
let wakeLock = null;
const native = window.AndroidBridge; // 안드로이드 앱(APK)에서만 존재

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
const addItem = (blob, type) => {
  if (native) saveNative(blob, type).catch(() => {});
  return tx('readwrite', s => s.add({ blob, type, time: Date.now() }));
};
// 앱에서는 촬영물을 기기 갤러리에도 자동 저장
async function saveNative(blob, type) {
  const ext = type === 'photo' ? 'jpg' : ((blob.type || '').includes('mp4') ? 'mp4' : 'webm');
  const name = 'silent-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
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

// ---------- 영상 촬영 ----------
async function toggleRecord() {
  if (recorder) return stopRecord();
  if (!stream) return;
  let tracks = [...stream.getVideoTracks()];
  try { // 소리는 마이크 허용 시에만 녹음
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tracks.push(...micStream.getAudioTracks());
  } catch (e) { micStream = null; }
  const types = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = window.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t));
  if (!mime) { alert('이 브라우저는 영상 촬영을 지원하지 않습니다.'); return; }
  recChunks = [];
  recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime });
  recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: mime.split(';')[0] });
    recorder = null;
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (blob.size) await addItem(blob, 'video');
    await refreshThumb();
  };
  recorder.start(1000);
  recStart = Date.now();
  $('recBtn').classList.add('on');
  $('badge').classList.add('rec');
  recTick = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('badge').textContent = '● ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 500);
}
function stopRecord() {
  if (!recorder) return;
  recorder.stop();
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
  a.download = 'silent-' + new Date(p.time).toISOString().replace(/[:.]/g, '-') + '.' + extOf(p);
  $('viewer').hidden = false;
}
function closeViewer() { $('viewerVideo').pause(); $('viewer').hidden = true; }

$('shutter').onclick = shoot;
$('recBtn').onclick = toggleRecord;
$('stealthBtn').onclick = enterStealth;
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
if (native) $('viewerSave').hidden = true; // 앱에서는 자동으로 갤러리에 저장됨
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
