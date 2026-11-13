# minitodo

할 일을 관리하는 작은 Node.js 서비스입니다. 외부 패키지 없이 Node.js 22 이상에서 실행됩니다.

- `npm start`: 서버 실행 (`src/server.mjs`)
- `npm test`: 테스트 실행

## 구조

- `src/config.mjs`: 환경 변수에서 서버 설정을 읽습니다.
- `src/db.mjs`: JSON 파일 기반 저장소와 스키마 마이그레이션입니다.
- `src/app.mjs`: HTTP API와 정적 파일 제공 (`createApp({ db })`).
- `src/server.mjs`: 설정·저장소·앱을 연결해 서버를 시작합니다.
- `public/`: 브라우저 화면. `render.js`는 DOM 없이 테스트할 수 있는 렌더링 함수입니다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/todos` | 목록. `?status=done` 또는 `?status=open`으로 필터 |
| POST | `/api/todos` | 생성. 본문 `{ "title": "..." }` |
| PATCH | `/api/todos/:id` | 수정. 본문 `{ "title"?, "done"? }` |
| DELETE | `/api/todos/:id` | 삭제 |

오류 응답은 `{ "error": "메시지" }` 형식의 JSON입니다.
