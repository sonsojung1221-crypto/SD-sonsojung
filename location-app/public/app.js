const $ = id => document.getElementById(id);
let nickname = '';
try { nickname = localStorage.getItem('nickname') || ''; } catch {}

function showMain() {
  $('login').hidden = !!nickname;
  $('main').hidden = !nickname;
  $('who').textContent = nickname;
  if (nickname) loadList();
}

function setStatus(text, isError) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : '';
}

async function loadList() {
  const list = await (await fetch('/api/checkins')).json();
  const ul = $('list'); ul.innerHTML = '';
  $('empty').hidden = list.length > 0;
  list.forEach(c => {
    const li = document.createElement('li');
    const name = document.createElement('strong'); name.textContent = c.nickname;
    const small = document.createElement('small');
    small.textContent = `${new Date(c.time).toLocaleString('ko-KR')} · ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} `;
    const a = document.createElement('a');
    a.href = `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=17/${c.lat}/${c.lng}`;
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = '지도 보기';
    small.appendChild(a);
    li.append(name, small);
    ul.appendChild(li);
  });
}

$('nickForm').onsubmit = e => {
  e.preventDefault();
  nickname = $('nick').value.trim();
  if (!nickname) return;
  try { localStorage.setItem('nickname', nickname); } catch {}
  showMain();
};

$('logout').onclick = () => {
  nickname = '';
  try { localStorage.removeItem('nickname'); } catch {}
  $('nick').value = '';
  showMain();
};

$('saveBtn').onclick = () => {
  if (!navigator.geolocation) return setStatus('이 브라우저는 위치 기능을 지원하지 않습니다.', true);
  $('saveBtn').disabled = true;
  setStatus('위치를 확인하는 중...');
  navigator.geolocation.getCurrentPosition(async pos => {
    try {
      const r = await fetch('/api/checkins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setStatus('저장되었습니다!');
      loadList();
    } catch (err) {
      setStatus(err.message || '저장에 실패했습니다.', true);
    }
    $('saveBtn').disabled = false;
  }, err => {
    setStatus(err.code === 1 ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.' : '위치를 가져오지 못했습니다.', true);
    $('saveBtn').disabled = false;
  }, { enableHighAccuracy: true, timeout: 15000 });
};

showMain();
