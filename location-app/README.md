# 내 위치 남기기

입장 시 닉네임을 입력하고, 버튼을 누르면 현재 위치(위도/경도)를 닉네임과 함께 서버에 저장하는 사이트입니다.

## 실행

    npm start        # http://localhost:3000  (PORT 환경변수로 변경 가능)

- 외부 패키지 없이 Node.js(18+)만 필요합니다.
- 데이터는 `data/checkins.json`에 저장됩니다 (`DATA_FILE`로 경로 변경 가능).
- 위치 기능은 HTTPS 또는 localhost에서만 동작합니다.

## API
- `POST /api/checkins` `{nickname, lat, lng, accuracy}` → 저장
- `GET /api/checkins` → 최근 100건 (최신순)
