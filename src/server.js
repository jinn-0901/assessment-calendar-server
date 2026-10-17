const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const db = require("./db");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in the server environment.");
}
if (isProduction) app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

// CORS must allow the exact frontend origin because session cookies are used.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin.replace(/\/$/, ""))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(helmet());
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "assessment.sid",
  secret: process.env.SESSION_SECRET || "local-development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use("/api/admin", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "학교 관리자 인증이 필요합니다." });
  next();
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function textValue(value, maxLength) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 && result.length <= maxLength ? result : null;
}

app.get("/api/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    res.status(503).json({ ok: false, error: "데이터베이스에 연결할 수 없습니다." });
  }
});

app.get("/api/me", (req, res) => {
  res.json({ admin: req.session.admin || null });
});


function hashRegistrationCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function makeRegistrationCode() {
  return crypto.randomBytes(12).toString("hex").toUpperCase();
}

// First code: issued by the service operator after verifying the school's representative.
// ADMIN_SETUP_KEY is only an operator credential; it is not a school-wide shared admin password.
app.post("/api/admin/registration-codes/bootstrap", async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const setupKey = typeof req.body.setupKey === "string" ? req.body.setupKey : "";
    const schoolId = positiveInt(req.body.schoolId);
    if (!process.env.ADMIN_SETUP_KEY || setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ error: "운영자 인증에 실패했습니다." });
    }
    if (!schoolId) return res.status(400).json({ error: "학교 선택이 올바르지 않습니다." });
    await client.query("BEGIN");
    const school = await client.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [schoolId]);
    if (!school.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "학교를 찾을 수 없습니다." }); }
    const code = makeRegistrationCode();
    await client.query(
      "UPDATE school_admin_registration_codes SET revoked_at=NOW() WHERE school_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
      [schoolId]
    );
    await client.query(
      "INSERT INTO school_admin_registration_codes (school_id,code_hash,expires_at,created_by) VALUES ($1,$2,NOW()+INTERVAL '24 hours','operator')",
      [schoolId, hashRegistrationCode(code)]
    );
    await client.query("COMMIT");
    res.status(201).json({ schoolId, registrationCode: code, expiresInHours: 24 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

// A valid one-time code creates the first administrator or resets/transfers the single school administrator account.
app.post("/api/admin/register", async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const schoolId = positiveInt(req.body.schoolId);
    const code = typeof req.body.registrationCode === "string" ? req.body.registrationCode.trim().toUpperCase() : "";
    const password = req.body.password;
    if (!schoolId || !/^[A-Z0-9]{20,24}$/.test(code) || typeof password !== "string" || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: "학교, 등록 코드, 12자 이상의 비밀번호를 확인해 주세요." });
    }
    await client.query("BEGIN");
    const school = await client.query("SELECT id,name FROM schools WHERE id=$1 FOR UPDATE", [schoolId]);
    if (!school.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "학교를 찾을 수 없습니다." }); }
    const codeResult = await client.query(
      "SELECT id FROM school_admin_registration_codes WHERE school_id=$1 AND code_hash=$2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE",
      [schoolId, hashRegistrationCode(code)]
    );
    if (!codeResult.rowCount) { await client.query("ROLLBACK"); return res.status(403).json({ error: "등록 코드가 올바르지 않거나 만료·사용된 코드입니다." }); }
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query("INSERT INTO school_admins (school_id,password_hash) VALUES ($1,$2) ON CONFLICT (school_id) DO UPDATE SET password_hash=EXCLUDED.password_hash", [schoolId, passwordHash]);
    await client.query("UPDATE school_admin_registration_codes SET used_at=NOW() WHERE id=$1", [codeResult.rows[0].id]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true, message: "학교 관리자 등록이 완료됐습니다." });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ error: "등록 코드가 이미 사용되었습니다. 새 코드를 요청해 주세요." });
    next(error);
  } finally { client.release(); }
});

// A logged-in school administrator can issue a short-lived one-time code for a verified school representative.
app.post("/api/admin/registration-codes", requireAdmin, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const schoolId = Number(req.session.admin.schoolId);
    await client.query("BEGIN");
    await client.query(
      "UPDATE school_admin_registration_codes SET revoked_at=NOW() WHERE school_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
      [schoolId]
    );
    const code = makeRegistrationCode();
    await client.query(
      "INSERT INTO school_admin_registration_codes (school_id,code_hash,expires_at,created_by) VALUES ($1,$2,NOW()+INTERVAL '24 hours',$3)",
      [schoolId, hashRegistrationCode(code), "school_admin:" + schoolId]
    );
    await client.query("COMMIT");
    res.status(201).json({ registrationCode: code, expiresInHours: 24 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

app.get("/api/admin/registration-codes", requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT id,expires_at,used_at,revoked_at,created_at FROM school_admin_registration_codes WHERE school_id=$1 ORDER BY created_at DESC LIMIT 20",
      [req.session.admin.schoolId]
    );
    res.json({ codes: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/admin/registration-codes/:id/revoke", requireAdmin, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: "코드 ID가 올바르지 않습니다." });
    const result = await db.query(
      "UPDATE school_admin_registration_codes SET revoked_at=NOW() WHERE id=$1 AND school_id=$2 AND used_at IS NULL AND revoked_at IS NULL RETURNING id",
      [id, req.session.admin.schoolId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "폐기할 수 있는 코드를 찾을 수 없습니다." });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/admin/login", async (req, res, next) => {
  try {
    const schoolId = positiveInt(req.body.schoolId);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const result = await db.query(
      "SELECT a.school_id,a.password_hash,s.name AS school_name FROM school_admins a JOIN schools s ON s.id=a.school_id WHERE a.school_id=$1",
      [schoolId]
    );
    const admin = result.rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: "학교 또는 관리자 비밀번호를 확인해 주세요." });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.admin = { schoolId: String(admin.school_id), schoolName: admin.school_name };
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.json({ admin: req.session.admin });
      });
    });
  } catch (error) { next(error); }
});

app.post("/api/admin/password", requireAdmin, async (req, res, next) => {
  try {
    const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    if (newPassword.length < 12 || newPassword.length > 128) {
      return res.status(400).json({ error: "새 비밀번호는 12~128자로 설정해 주세요." });
    }
    const result = await db.query(
      "SELECT password_hash FROM school_admins WHERE school_id=$1",
      [req.session.admin.schoolId]
    );
    if (!result.rowCount || !(await bcrypt.compare(currentPassword, result.rows[0].password_hash))) {
      return res.status(403).json({ error: "현재 비밀번호가 올바르지 않습니다." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query("UPDATE school_admins SET password_hash=$1 WHERE school_id=$2", [passwordHash, req.session.admin.schoolId]);
    res.json({ ok: true, message: "관리자 비밀번호가 변경되었습니다." });
  } catch (error) { next(error); }
});

app.post("/api/admin/logout", requireAdmin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("assessment.sid", { httpOnly: true, sameSite: isProduction ? "none" : "lax", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/admin/requests", requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT r.id,r.school_id,r.assessment_id,r.action,r.payload,r.created_at,s.name AS school_name
       FROM assessment_requests r JOIN schools s ON s.id=r.school_id
       WHERE r.school_id=$1 AND r.status='pending' ORDER BY r.created_at ASC`,
      [req.session.admin.schoolId]
    );
    res.json({ requests: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/admin/requests/:id/decision", requireAdmin, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const id = positiveInt(req.params.id);
    const decision = req.body.decision;
    if (!id || !["approve","reject"].includes(decision)) return res.status(400).json({ error: "승인 요청이 올바르지 않습니다." });
    await client.query("BEGIN");
    const request = await client.query(
      "SELECT * FROM assessment_requests WHERE id=$1 AND school_id=$2 AND status='pending' FOR UPDATE",
      [id, req.session.admin.schoolId]
    );
    if (!request.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "대기 중인 요청을 찾을 수 없습니다." }); }
    const row = request.rows[0];
    if (decision === "approve") {
      const p = row.payload;
      if (row.action === "create") {
        await client.query(
          "INSERT INTO assessments (class_id,subject_id,title,details,due_date,created_by) VALUES ($1,$2,$3,$4,$5,NULL)",
          [p.classId,p.subjectId,p.title,p.details,p.dueDate]
        );
      } else if (row.action === "edit") {
        await client.query(
          "UPDATE assessments SET class_id=$1,subject_id=$2,title=$3,details=$4,due_date=$5,updated_at=NOW() WHERE id=$6",
          [p.classId,p.subjectId,p.title,p.details,p.dueDate,row.assessment_id]
        );
      }
    }
    await client.query(
      "UPDATE assessment_requests SET status=$1, reviewed_at=NOW(), reviewed_by_school_admin=$2 WHERE id=$3",
      [decision === "approve" ? "approved" : "rejected", req.session.admin.schoolId, id]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "P0001") return res.status(400).json({ error: "학급과 과목은 같은 학교에 속해야 합니다." });
    next(error);
  } finally { client.release(); }
});


app.get("/api/neis/schools", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 2 || query.length > 80) {
    return res.status(400).json({ error: "학교 이름을 두 글자 이상 입력해 주세요." });
  }
  const key = process.env.NEIS_API_KEY;
  if (!key) return res.status(503).json({ error: "학교 검색 API가 아직 설정되지 않았어요. 서버의 NEIS_API_KEY를 설정해 주세요." });

  try {
    const params = new URLSearchParams({
      KEY: key,
      Type: "json",
      pIndex: "1",
      pSize: "20",
      SCHUL_NM: query
    });
    const response = await fetch("https://open.neis.go.kr/hub/schoolInfo?" + params.toString(), {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return res.status(502).json({ error: "나이스 학교 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요." });
    const payload = await response.json();
    const rows = payload?.schoolInfo?.[1]?.row || [];
    const errorResult = payload?.RESULT;
    if (!rows.length && errorResult?.CODE && errorResult.CODE !== "INFO-200") {
      return res.status(502).json({ error: "나이스 학교 검색에서 응답 오류가 발생했어요." });
    }
    // Moa is for secondary-school performance assessment schedules only.
    const secondarySchools = rows.filter((row) =>
      ["중학교", "고등학교"].includes((row.SCHUL_KND_SC_NM || "").trim())
    );
    res.json({
      schools: secondarySchools.map((row) => ({
        name: row.SCHUL_NM,
        region: row.LCTN_SC_NM || row.ATPT_OFCDC_SC_NM || "",
        address: row.ORG_RDNMA || row.ORG_RDNZC || "",
        schoolType: row.SCHUL_KND_SC_NM || "",
        officeCode: row.ATPT_OFCDC_SC_CODE,
        schoolCode: row.SD_SCHUL_CODE
      }))
    });
  } catch (error) {
    console.error("NEIS school search failed:", error.message);
    res.status(502).json({ error: "나이스 학교 검색에 연결할 수 없어요. 잠시 후 다시 시도해 주세요." });
  }
});

app.get("/api/neis/classes", rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const schoolId = positiveInt(req.query.schoolId);
  const grade = typeof req.query.grade === "string" ? req.query.grade.trim() : "";
  if (!schoolId) return res.status(400).json({ error: "학교 선택이 올바르지 않습니다." });
  if (grade && !/^\d{1,2}$/.test(grade)) return res.status(400).json({ error: "학년 값이 올바르지 않습니다." });
  const key = process.env.NEIS_API_KEY;
  if (!key) return res.status(503).json({ error: "나이스 학급 조회 API가 설정되지 않았어요." });
  try {
    const schoolResult = await db.query("SELECT neis_office_code, neis_school_code FROM schools WHERE id=$1", [schoolId]);
    const school = schoolResult.rows[0];
    if (!school) return res.status(404).json({ error: "학교를 찾을 수 없습니다." });
    if (!school.neis_office_code || !school.neis_school_code) {
      return res.status(400).json({ error: "이 학교는 나이스 학교 코드가 없어 학급 정보를 조회할 수 없습니다. 학교를 나이스 검색으로 다시 등록해 주세요." });
    }
    const params = new URLSearchParams({
      KEY: key, Type: "json", pIndex: "1", pSize: "1000",
      ATPT_OFCDC_SC_CODE: school.neis_office_code,
      SD_SCHUL_CODE: school.neis_school_code
    });
    if (grade) params.set("GRADE", grade);
    const response = await fetch("https://open.neis.go.kr/hub/classInfo?" + params.toString(), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(502).json({ error: "나이스 학급 정보를 가져오지 못했어요." });
    const payload = await response.json();
    const rows = payload?.classInfo?.[1]?.row || [];
    const errorResult = payload?.RESULT;
    if (!rows.length && errorResult?.CODE && errorResult.CODE !== "INFO-200") {
      return res.status(502).json({ error: "나이스 학급 조회 오류: " + (errorResult.MESSAGE || errorResult.CODE) });
    }
    const grades = [...new Set(rows.map(row => String(row.GRADE || "").trim()).filter(Boolean))].sort((a,b) => Number(a)-Number(b));
    const classes = [...new Set(rows.filter(row => !grade || String(row.GRADE || "").trim() === grade).map(row => String(row.CLASS_NM || "").trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, "ko", { numeric: true }));
    res.json({ grades, classes });
  } catch (error) {
    console.error("NEIS class lookup failed:", error.message);
    res.status(502).json({ error: "나이스 학급 조회에 연결할 수 없어요. 잠시 후 다시 시도해 주세요." });
  }
});

app.get("/api/schools", async (req, res, next) => {
  try {
    const result = await db.query("SELECT id, name, region FROM schools ORDER BY name, region");
    res.json({ schools: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/schools", async (req, res, next) => {
  try {
    const name = textValue(req.body.name, 160);
    const region = typeof req.body.region === "string" ? req.body.region.trim().slice(0, 120) : "";
    const officeCodeValue = typeof req.body.officeCode === "string" ? req.body.officeCode.trim() : "";
    const schoolCodeValue = typeof req.body.schoolCode === "string" ? req.body.schoolCode.trim() : "";
    const officeCode = officeCodeValue ? officeCodeValue.slice(0, 10) : null;
    const schoolCode = schoolCodeValue ? schoolCodeValue.slice(0, 20) : null;
    if (!name) return res.status(400).json({ error: "학교명을 입력해 주세요." });
    if ((officeCode && !schoolCode) || (!officeCode && schoolCode)) {
      return res.status(400).json({ error: "나이스 학교 코드 정보가 올바르지 않습니다." });
    }
    const result = await db.query(
      "INSERT INTO schools (name, region, neis_office_code, neis_school_code) VALUES ($1, $2, $3, $4) ON CONFLICT (name, region) DO UPDATE SET neis_office_code = COALESCE(EXCLUDED.neis_office_code, schools.neis_office_code), neis_school_code = COALESCE(EXCLUDED.neis_school_code, schools.neis_school_code) RETURNING id, name, region",
      [name, region, officeCode, schoolCode]
    );
    res.status(201).json({ school: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/schools/:schoolId/classes", async (req, res, next) => {
  try {
    const schoolId = positiveInt(req.params.schoolId);
    if (!schoolId) return res.status(400).json({ error: "학교 선택이 올바르지 않습니다." });
    const result = await db.query(
      "SELECT id, school_id, grade, class_number FROM classes WHERE school_id = $1 ORDER BY grade, class_number",
      [schoolId]
    );
    res.json({ classes: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/classes", async (req, res, next) => {
  try {
    const schoolId = positiveInt(req.body.schoolId);
    const grade = Number(req.body.grade);
    const classNumber = Number(req.body.classNumber);
    if (!schoolId || !Number.isInteger(grade) || grade < 1 || grade > 12 ||
        !Number.isInteger(classNumber) || classNumber < 1 || classNumber > 99) {
      return res.status(400).json({ error: "학교, 학년, 반을 올바르게 입력해 주세요." });
    }
    const result = await db.query(
      "INSERT INTO classes (school_id, grade, class_number) VALUES ($1, $2, $3) ON CONFLICT (school_id, grade, class_number) DO UPDATE SET grade = EXCLUDED.grade RETURNING id, school_id, grade, class_number",
      [schoolId, grade, classNumber]
    );
    res.status(201).json({ class: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/schools/:schoolId/subjects", async (req, res, next) => {
  try {
    const schoolId = positiveInt(req.params.schoolId);
    if (!schoolId) return res.status(400).json({ error: "학교 선택이 올바르지 않습니다." });
    const result = await db.query("SELECT id, school_id, name FROM subjects WHERE school_id = $1 ORDER BY name", [schoolId]);
    res.json({ subjects: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/subjects", async (req, res, next) => {
  try {
    const schoolId = positiveInt(req.body.schoolId);
    const name = textValue(req.body.name, 100);
    if (!schoolId || !name) return res.status(400).json({ error: "학교와 과목명을 입력해 주세요." });
    const result = await db.query(
      "INSERT INTO subjects (school_id, name) VALUES ($1, $2) ON CONFLICT (school_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id, school_id, name",
      [schoolId, name]
    );
    res.status(201).json({ subject: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/assessments", async (req, res, next) => {
  try {
    const classId = positiveInt(req.query.classId);
    if (!classId) return res.status(400).json({ error: "학급을 선택해 주세요." });
    const result = await db.query(
      `SELECT a.id, a.class_id, a.subject_id, a.title, a.details,
              to_char(a.due_date, 'YYYY-MM-DD') AS due_date,
              a.created_by, COALESCE(u.display_name, '학생') AS author, s.name AS subject_name,
              c.school_id, c.grade, c.class_number, sc.name AS school_name, sc.region
       FROM assessments a
       LEFT JOIN users u ON u.id = a.created_by
       JOIN subjects s ON s.id = a.subject_id
       JOIN classes c ON c.id = a.class_id
       JOIN schools sc ON sc.id = c.school_id
       WHERE a.class_id = $1 AND a.status = 'approved'
       ORDER BY a.due_date ASC, a.id DESC`,
      [classId]
    );
    res.json({ assessments: result.rows });
  } catch (error) { next(error); }
});

async function validateAssessmentPayload(body) {
  const classId = positiveInt(body.classId);
  const subjectId = positiveInt(body.subjectId);
  const title = textValue(body.title, 180);
  const dueDate = typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : null;
  const details = typeof body.details === "string" ? body.details.trim().slice(0, 3000) : "";
  if (!classId || !subjectId || !title || !dueDate) return { error: "학급, 과목, 제목, 날짜를 모두 입력해 주세요." };
  const context = await db.query(
    "SELECT c.school_id,s.school_id AS subject_school_id FROM classes c CROSS JOIN subjects s WHERE c.id=$1 AND s.id=$2",
    [classId, subjectId]
  );
  if (!context.rowCount || String(context.rows[0].school_id) !== String(context.rows[0].subject_school_id)) {
    return { error: "학급과 과목은 같은 학교에 속해야 합니다." };
  }
  return { payload: { classId, subjectId, title, details, dueDate }, schoolId: context.rows[0].school_id };
}

app.post("/api/assessments", async (req, res, next) => {
  try {
    const validated = await validateAssessmentPayload(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    await db.query(
      "INSERT INTO assessment_requests (school_id,action,payload) VALUES ($1,'create',$2::jsonb)",
      [validated.schoolId, JSON.stringify(validated.payload)]
    );
    res.status(202).json({ pending: true, message: "일정 등록 신청을 보냈어요. 학교 관리자 승인 후 공개됩니다." });
  } catch (error) { next(error); }
});

app.put("/api/assessments/:id", async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: "일정 ID가 올바르지 않습니다." });
    const current = await db.query(
      `SELECT a.id,c.school_id FROM assessments a JOIN classes c ON c.id=a.class_id
       WHERE a.id=$1 AND a.status='approved'`, [id]
    );
    if (!current.rowCount) return res.status(404).json({ error: "일정을 찾을 수 없습니다." });
    const validated = await validateAssessmentPayload(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    if (String(current.rows[0].school_id) !== String(validated.schoolId)) {
      return res.status(400).json({ error: "일정은 원래 학교 안에서만 수정 신청할 수 있습니다." });
    }
    await db.query(
      "INSERT INTO assessment_requests (school_id,assessment_id,action,payload) VALUES ($1,$2,'edit',$3::jsonb)",
      [validated.schoolId,id,JSON.stringify(validated.payload)]
    );
    res.status(202).json({ pending: true, message: "수정 신청을 보냈어요. 관리자 승인 후 변경됩니다." });
  } catch (error) { next(error); }
});

app.delete("/api/assessments/:id", (req, res) => {
  res.status(403).json({ error: "일정 삭제는 관리자에게 요청해 주세요." });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "요청한 API를 찾을 수 없습니다." });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
});

async function startServer() {
  try {
    await db.query("ALTER TABLE schools ADD COLUMN IF NOT EXISTS neis_office_code VARCHAR(10)");
    await db.query("ALTER TABLE schools ADD COLUMN IF NOT EXISTS neis_school_code VARCHAR(20)");
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_neis_codes ON schools(neis_office_code, neis_school_code) WHERE neis_office_code IS NOT NULL AND neis_school_code IS NOT NULL");
    await db.query("CREATE TABLE IF NOT EXISTS school_admin_registration_codes (id BIGSERIAL PRIMARY KEY, school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE, code_hash CHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_by VARCHAR(160) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await db.query("CREATE INDEX IF NOT EXISTS idx_school_admin_registration_codes_school ON school_admin_registration_codes(school_id, created_at DESC)");
  } catch (error) {
    console.warn("School code migration skipped; database setup may be required:", error.message);
  }
  app.listen(port, () => console.log(`Assessment Calendar server listening on port ${port}`));
}

startServer();
