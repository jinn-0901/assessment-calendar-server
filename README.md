# 모아 — 수행평가 일정 API 서버

모아 수행평가 통합 일정표의 Node.js + Express + PostgreSQL 백엔드입니다. 프런트엔드는 별도 저장소에서 관리합니다.

## 서비스 및 저장소

- **웹사이트:** https://jinn-0901.github.io/assessment-calendar-web/
- **API 서버:** https://assessment-calendar-server.onrender.com
- **API 상태 확인:** https://assessment-calendar-server.onrender.com/api/health
- **프런트엔드 저장소:** https://github.com/jinn-0901/assessment-calendar-web
- **백엔드 저장소:** https://github.com/jinn-0901/assessment-calendar-server

## 기능

- 학교·학급·과목 및 수행평가 일정 API
- 학생의 일정 등록·수정 신청
- 학교 관리자 인증 및 신청 승인·반려
- NEIS 교육정보 개방 포털을 통한 학교 검색
- PostgreSQL 데이터 저장
- 지난 학년도 수행평가 일정 자동 정리

학생이 제출한 일정 등록·수정 신청은 관리자 승인 전까지 공개 일정에 반영되지 않습니다. 관리자가 직접 등록한 일정은 즉시 공개됩니다.

## 기술 스택

- Node.js 20 이상
- Express
- PostgreSQL (`pg`)
- Express Session 및 PostgreSQL 세션 저장소

## 로컬 실행

Node.js 20 이상과 PostgreSQL 데이터베이스가 필요합니다.

```bash
npm install
npm start
```

개발 모드:

```bash
npm run dev
```

서버 상태 확인 경로는 `GET /api/health`입니다.

## 서버 환경 변수

호스팅 서비스의 환경 변수 설정에 다음 값을 등록하세요.

| 변수 | 설명 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 연결 문자열 |
| `SESSION_SECRET` | 충분히 길고 무작위인 세션 비밀값 |
| `ADMIN_SETUP_KEY` | 관리자 최초 설정용 비밀 키 |
| `NODE_ENV` | 배포 환경에서는 `production` |
| `FRONTEND_URL` | 프런트엔드의 HTTPS origin |
| `FRONTEND_URLS` | 여러 프런트엔드 origin을 허용할 때 사용하는 쉼표 구분 목록. 설정 시 허용 목록으로 사용 |
| `NEIS_API_KEY` | NEIS 교육정보 개방 포털에서 발급받은 API 키 |

`FRONTEND_URL`과 `FRONTEND_URLS`에는 끝에 슬래시가 없는 origin을 사용하세요. 비밀 키와 데이터베이스 연결 문자열을 소스 코드나 공개 저장소에 올리지 마세요.

NEIS API 키 발급 및 안내: [NEIS 교육정보 개방 포털](https://open.neis.go.kr/portal/guide/apiGuidePage.do)

## 데이터베이스 준비

- 새 데이터베이스를 만드는 경우에만 `schema.sql`을 실행하세요.
- 기존 데이터베이스를 사용한다면 초기화하거나 기존 스키마를 무작정 덮어쓰지 마세요.
- 기존 데이터베이스에는 현재 스키마와 마이그레이션 파일을 확인한 뒤 필요한 변경만 적용하세요.
- 서버 시작 시 일부 호환성 컬럼과 인덱스가 자동으로 준비됩니다.

현재 서비스는 Render에 API를 배포하고 PostgreSQL 데이터베이스를 사용합니다. 실제 배포 설정과 환경 변수는 해당 호스팅 서비스의 설정을 기준으로 확인하세요.

## 학교 관리자 최초 설정

1. 웹사이트에서 학교를 등록합니다.
2. 백엔드 호스팅 환경 변수에 `ADMIN_SETUP_KEY`를 설정합니다.
3. `GET /api/schools` 응답에서 학교 ID를 확인합니다.
4. 아래 요청의 예시 값을 실제 값으로 바꿔 관리자 비밀번호를 설정합니다.

```bash
curl -X POST "$API_URL/api/admin/setup" \
  -H "Content-Type: application/json" \
  -d '{"setupKey":"YOUR_ADMIN_SETUP_KEY","schoolId":1,"password":"YOUR_LONG_ADMIN_PASSWORD"}'
```

관리자 비밀번호는 최소 12자여야 합니다. 실제 설정 키와 비밀번호를 채팅이나 GitHub에 올리지 마세요. 설정 후 웹사이트의 **관리자** 메뉴에서 학교와 비밀번호로 로그인할 수 있습니다.

## 주요 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 서버 상태 |
| GET | `/api/me` | 현재 인증 상태 |
| POST | `/api/admin/setup` | 관리자 최초 설정 |
| POST | `/api/admin/login` | 관리자 로그인 |
| POST | `/api/admin/logout` | 관리자 로그아웃 |
| GET | `/api/admin/requests` | 신청 목록 |
| POST | `/api/admin/requests/:id/decision` | 신청 승인 또는 반려 |
| GET / POST | `/api/schools` | 학교 조회·등록 |
| GET / POST | `/api/schools/:schoolId/classes`, `/api/classes` | 학급 조회·등록 |
| GET / POST | `/api/schools/:schoolId/subjects`, `/api/subjects` | 과목 조회·등록 |
| GET / POST / PUT / DELETE | `/api/assessments`, `/api/assessments/:id` | 수행평가 일정 조회·등록·수정·삭제 |

## 매년 3월 수행평가 일정 자동 정리

서버는 한국 시간(`Asia/Seoul`)을 기준으로 매년 3월 1일 이후의 실행 날짜를 확인합니다.

- 3월 1일이 주말이면 3·1절 대체공휴일을 고려해 다음 평일까지 건너뜁니다.
- 정리 대상은 해당 연도 3월 1일보다 **종료일이 앞선** 수행평가 일정입니다.
- 3월 1일 당일 또는 이후에 종료되는 일정은 삭제하지 않습니다.
- 일정에 연결된 승인 대기 신청이 있다면 해당 일정은 삭제하지 않아 신청이 보존되도록 합니다. 승인 대기 신청 자체도 자동 정리 대상이 아닙니다.
- 학년도별 실행 기록으로 중복 정리를 방지합니다.
- 이 기능을 3월 실행 예정일이 지난 뒤 처음 배포하면, 기존 일정을 즉시 소급 삭제하지 않고 다음 학년도 정리부터 시작합니다.

자동 정리는 백엔드 프로세스에서 확인됩니다. 호스팅 서비스가 정지되어 있으면 정지 중에는 실행되지 않으며, 서버가 다시 시작된 뒤 실행 여부를 확인합니다. 배포 후 로그와 데이터베이스 상태를 확인하세요.

## 보안 참고

- `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_SETUP_KEY`, `NEIS_API_KEY`는 비밀 정보로 관리하세요.
- 관리자 비밀번호와 실제 인증 정보를 문서나 커밋에 넣지 마세요.
- 데이터베이스 스키마를 변경하기 전에는 기존 데이터와 외래 키 관계를 확인하세요.
