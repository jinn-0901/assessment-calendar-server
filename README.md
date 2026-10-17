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
- `ADMIN_SETUP_KEY`: 학교 관리자 최초 등록에만 사용하는 긴 비밀 키
- `NODE_ENV`: `production`
- `FRONTEND_URL`: 배포한 프런트엔드의 HTTPS 주소 (예: `https://your-web.onrender.com`, 끝에 `/` 없이). 여러 origin은 `FRONTEND_URLS`에 쉼표로 구분해 지정할 수도 있습니다.

서버를 배포한 후 `API_BASE_URL`을 웹 Static Site 환경 변수에 서버의 HTTPS 주소로 설정하세요. 관리자 세션 쿠키를 사용하므로 웹과 서버 모두 HTTPS로 배포해야 합니다.

## 로그인 없는 학생 등록 / 학교별 관리자 승인

- 학생은 로그인하지 않고 새 일정 또는 수정 사항을 신청합니다. 신청은 `assessment_requests`에 저장되며 승인 전까지 공개 일정에 나타나지 않습니다.
- 학교별 관리자만 해당 학교의 신청 목록을 조회하고 승인/반려할 수 있습니다.
- Render PostgreSQL에 기존 DB가 있다면 `migration_approval.sql`을 한 번 실행하세요. 새 DB라면 `schema.sql`을 실행하면 됩니다.
- Render 서버 환경 변수에 `ADMIN_SETUP_KEY`를 설정하세요. 이는 관리자 계정 초기 설정용 비밀값이며 웹 코드에 넣지 마세요.
- 학교를 먼저 사이트에서 등록한 다음, 아래 요청으로 해당 학교의 관리자 비밀번호를 초기화하세요. `API_URL`, `SCHOOL_ID`, `ADMIN_SETUP_KEY`, `ADMIN_PASSWORD`를 실제 값으로 바꿔 터미널에서 실행합니다. 관리자 비밀번호는 최소 12자입니다.

```bash
curl -X POST "$API_URL/api/admin/setup" \
  -H "Content-Type: application/json" \
  -d '{"setupKey":"ADMIN_SETUP_KEY","schoolId":SCHOOL_ID,"password":"ADMIN_PASSWORD"}'
```

관리자는 사이트의 **관리자** 버튼에서 학교와 관리자 비밀번호로 인증한 뒤 **승인함**에서 신청을 처리합니다. 관리자 비밀번호를 학생에게 공유하지 마세요.

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
