// 무음 카메라: getUserMedia 영상 프레임을 canvas로 캡처하므로 셔터음이 나지 않습니다.
const $ = id => document.getElementById(id);
const preview = $('preview');
let stream = null, facing = 'environment', timer = 0, busy = false;

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
const addPhoto = blob => tx('readwrite', s => s.add({ blob, time: Date.now() }));
const allPhotos = () => tx('readonly', s => s.getAll()).then(a => a.reverse());
const delPhoto = id => tx('readwrite', s => s.delete(id));
const clearPhotos = () => tx('readwrite', s => s.clear());

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
  const f = $('flash'); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); // 소리 없는 시각 피드백
  if (navigator.vibrate) navigator.vibrate(0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  await addPhoto(blob);
  await refreshThumb();
  busy = false;
}

async function shoot() {
  if (!timer) return capture();
  const cd = $('countdown');
  cd.hidden = false;
  for (let n = timer; n > 0; n--) { cd.textContent = n; await new Promise(r => setTimeout(r, 1000)); }
  cd.hidden = true;
  capture();
}

// ---------- UI ----------
let thumbUrl;
async function refreshThumb() {
  const list = await allPhotos();
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  if (list.length) { thumbUrl = URL.createObjectURL(list[0].blob); $('thumbImg').src = thumbUrl; }
  else { $('thumbImg').removeAttribute('src'); }
}

let urls = [];
async function openGallery() {
  const list = await allPhotos();
  urls.forEach(URL.revokeObjectURL); urls = [];
  const grid = $('grid'); grid.innerHTML = '';
  list.forEach(p => {
    const u = URL.createObjectURL(p.blob); urls.push(u);
    const img = new Image(); img.src = u; img.alt = '사진';
    img.onclick = () => openViewer(p, u);
    grid.appendChild(img);
  });
  $('empty').hidden = list.length > 0;
  $('gallery').hidden = false;
}
let current;
function openViewer(p, u) {
  current = p; $('viewerImg').src = u;
  const a = $('viewerSave'); a.href = u;
  a.download = 'silent-' + new Date(p.time).toISOString().replace(/[:.]/g, '-') + '.jpg';
  $('viewer').hidden = false;
}

$('shutter').onclick = shoot;
$('flipBtn').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('timerBtn').onclick = () => {
  timer = timer === 0 ? 3 : timer === 3 ? 10 : 0;
  $('timerLabel').textContent = timer ? timer + '초' : '끔';
};
$('thumb').onclick = $('galleryBtn').onclick = openGallery;
$('closeGallery').onclick = () => { $('gallery').hidden = true; refreshThumb(); };
$('viewerClose').onclick = () => $('viewer').hidden = true;
$('viewerDelete').onclick = async () => {
  if (!confirm('이 사진을 삭제할까요?')) return;
  await delPhoto(current.id); $('viewer').hidden = true; openGallery();
};
$('clearAll').onclick = async () => {
  if (confirm('모든 사진을 삭제할까요?')) { await clearPhotos(); openGallery(); }
};
// 볼륨 버튼/스페이스바로도 촬영
document.addEventListener('keydown', e => {
  if ((e.code === 'Space' || e.code === 'Enter') && $('gallery').hidden && $('viewer').hidden) { e.preventDefault(); shoot(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !stream?.active) startCamera(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refreshThumb();
startCamera();
