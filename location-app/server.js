// 닉네임 + 현재 위치 저장 서버 (외부 의존성 없음, JSON 파일 저장)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'checkins.json');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
const load = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } };
const save = list => fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 10_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/checkins' && req.method === 'GET') {
    return send(res, 200, load().slice(-100).reverse());
  }

  if (url.pathname === '/api/checkins' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
    const nickname = String(b.nickname || '').trim().slice(0, 20);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!nickname) return send(res, 400, { error: '닉네임을 입력해 주세요.' });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return send(res, 400, { error: '위치 정보가 올바르지 않습니다.' });
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      nickname, lat, lng,
      accuracy: Number.isFinite(Number(b.accuracy)) ? Math.round(Number(b.accuracy)) : null,
      time: new Date().toISOString()
    };
    const list = load(); list.push(entry); save(list);
    return send(res, 201, entry);
  }

  // 정적 파일
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
    return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
