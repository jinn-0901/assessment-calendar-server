# 모아 — 수행평가 일정 API 서버

Node.js + Express + PostgreSQL 백엔드입니다. 프런트엔드는 별도 저장소 `jinn-0901/assessment-calendar-web`에서 관리합니다.

## Render Web Service 설정
- Repository: `jinn-0901/assessment-calendar-server`
- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node

## 필수 환경 변수
- `DATABASE_URL`: Render PostgreSQL 연결 문자열
- `SESSION_SECRET`: 충분히 길고 무작위인 세션 비밀값
- `NODE_ENV`: `production`
- `FRONTEND_URL`: 배포한 프런트엔드의 HTTPS 주소 (예: `https://your-web.onrender.com`, 끝에 `/` 없이). 여러 origin은 `FRONTEND_URLS`에 쉼표로 구분해 지정할 수도 있습니다.

서버를 배포한 후 `API_BASE_URL`을 웹 Static Site 환경 변수에 서버의 HTTPS 주소로 설정하세요. 로그인 세션은 cross-origin 쿠키를 사용하므로 웹과 서버 모두 HTTPS로 배포해야 합니다.

## 데이터베이스 초기화
Render PostgreSQL을 생성한 뒤 SQL 편집기에서 이 저장소의 `schema.sql`을 실행하세요.

## API
- `GET /api/health`
- `GET /api/me`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/schools`, `POST /api/schools`
- `GET /api/schools/:schoolId/classes`, `POST /api/classes`
- `GET /api/schools/:schoolId/subjects`, `POST /api/subjects`
- `GET /api/assessments`, `POST /api/assessments`, `PUT /api/assessments/:id`, `DELETE /api/assessments/:id`
