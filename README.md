# 모아 — 수행평가 일정 API 서버

Node.js + Express + PostgreSQL 백엔드입니다. 프런트엔드는 별도 저장소 `jinn-0901/assessment-calendar-web`에서 관리합니다.

## 권장 배포 구성

- API 서버: Koyeb Web Service (Node.js buildpack)
- PostgreSQL: Neon
- Repository: `jinn-0901/assessment-calendar-server`
- Build command: `npm install`
- Run command: `npm start`
- Node.js: 20 이상
- Health check: `/api/health`

Koyeb 무료 인스턴스는 일정 시간 요청이 없으면 절전 상태가 될 수 있습니다. 무료 플랜의 현재 한도와 조건은 배포 전에 확인하세요.

## 필수 서버 환경 변수

- `DATABASE_URL`: Neon PostgreSQL 연결 문자열
- `SESSION_SECRET`: 길고 무작위인 세션 비밀값. GitHub에 올리지 마세요.
- `ADMIN_SETUP_KEY`: 관리자 최초 등록용 비밀 키. 웹 코드에 넣지 마세요.
- `NODE_ENV`: `production`
- `FRONTEND_URL`: 배포된 프런트엔드의 HTTPS origin (끝에 `/` 없이)
- `FRONTEND_URLS`: 프런트엔드 origin이 여러 개일 때 쉼표로 구분한 목록. `FRONTEND_URL` 대신 사용할 수 있습니다.

서버 배포 후 프런트엔드 빌드 환경 변수 `API_BASE_URL`에 서버의 HTTPS 주소를 설정하고 다시 배포하세요. 관리자 로그인은 세션 쿠키를 사용하므로, 프런트엔드와 서버를 연결한 뒤 브라우저에서 로그인 세션이 유지되는지 실제로 확인해야 합니다.

## 데이터베이스 준비

- 새 Neon 데이터베이스라면 SQL Editor에서 `schema.sql`을 한 번 실행하세요.
- 기존 데이터베이스를 재사용한다면 초기화하지 마세요. 현재 스키마를 확인하고, 필요한 경우에만 `migration_approval.sql`을 한 번 실행하세요.
- `schema.sql`과 `migration_approval.sql`을 같은 기존 데이터베이스에 무작정 연속 실행하지 마세요.

## 학교 관리자 최초 설정

1. 웹사이트에서 학교를 등록합니다.
2. 서버의 `ADMIN_SETUP_KEY` 환경 변수에 비밀 키를 설정합니다.
3. `GET /api/schools` 응답에서 해당 학교의 ID를 확인합니다.
4. 아래 요청을 보내 관리자 비밀번호를 등록합니다. 비밀번호는 최소 12자여야 합니다.

```bash
curl -X POST "$API_URL/api/admin/setup" \
  -H "Content-Type: application/json" \
  -d '{"setupKey":"YOUR_ADMIN_SETUP_KEY","schoolId":1,"password":"YOUR_LONG_ADMIN_PASSWORD"}'
```

위 예시의 `API_URL`, 학교 ID, 설정 키, 비밀번호는 실제 값으로 바꾸세요. 실제 비밀값을 채팅이나 GitHub에 올리지 마세요.

관리자는 웹사이트의 **관리자** 버튼에서 학교와 비밀번호로 인증한 뒤 **승인함**에서 신청을 처리합니다.

## 주요 API

- `GET /api/health`
- `GET /api/me`
- `POST /api/admin/setup`, `POST /api/admin/login`, `POST /api/admin/logout`
- `GET /api/admin/requests`, `POST /api/admin/requests/:id/decision`
- `GET /api/schools`, `POST /api/schools`
- `GET /api/schools/:schoolId/classes`, `POST /api/classes`
- `GET /api/schools/:schoolId/subjects`, `POST /api/subjects`
- `GET /api/assessments`, `POST /api/assessments`, `PUT /api/assessments/:id`, `DELETE /api/assessments/:id`


## NEIS school search

The school setup form searches the NEIS Education Information Open API through the backend so the API key is not exposed in the browser.

Set the following environment variable on the backend hosting service:

- `NEIS_API_KEY`: API key issued by the [NEIS Education Information Open Portal](https://open.neis.go.kr/portal/guide/apiGuidePage.do).

The server automatically adds the NEIS code columns to the `schools` table at startup. The same columns and index are also included in `schema.sql` for fresh database setup.
