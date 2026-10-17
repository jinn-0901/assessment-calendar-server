const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in the Render environment.");
}
if (isProduction) app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\\/$/, ""))
  .filter(Boolean);

// CORS must allow the exact frontend origin because session cookies are used.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin.replace(/\\/$/, ""))) {
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

app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "일정을 등록하거나 수정하려면 로그인해 주세요." });
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
  res.json({ user: req.session.user || null });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = textValue(req.body.email, 254)?.toLowerCase();
    const displayName = textValue(req.body.displayName, 80);
    const password = req.body.password;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "올바른 이메일 주소를 입력해 주세요." });
    }
    if (!displayName) return res.status(400).json({ error: "표시 이름을 입력해 주세요." });
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "비밀번호는 8~128자로 설정해 주세요." });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, display_name",
      [email, displayName, passwordHash]
    );
    req.session.user = { id: result.rows[0].id, email: result.rows[0].email, displayName: result.rows[0].display_name };
    res.status(201).json({ user: req.session.user });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "이미 가입된 이메일입니다." });
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const result = await db.query("SELECT id, email, display_name, password_hash FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "이메일 또는 비밀번호를 확인해 주세요." });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = { id: user.id, email: user.email, displayName: user.display_name };
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.json({ user: req.session.user });
      });
    });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("assessment.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/schools", async (req, res, next) => {
  try {
    const result = await db.query("SELECT id, name, region FROM schools ORDER BY name, region");
    res.json({ schools: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/schools", requireLogin, async (req, res, next) => {
  try {
    const name = textValue(req.body.name, 160);
    const region = typeof req.body.region === "string" ? req.body.region.trim().slice(0, 120) : "";
    if (!name) return res.status(400).json({ error: "학교명을 입력해 주세요." });
    const result = await db.query(
      "INSERT INTO schools (name, region) VALUES ($1, $2) ON CONFLICT (name, region) DO UPDATE SET name = EXCLUDED.name RETURNING id, name, region",
      [name, region]
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

app.post("/api/classes", requireLogin, async (req, res, next) => {
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

app.post("/api/subjects", requireLogin, async (req, res, next) => {
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
              a.created_by, u.display_name AS author, s.name AS subject_name,
              c.school_id, c.grade, c.class_number, sc.name AS school_name, sc.region
       FROM assessments a
       JOIN users u ON u.id = a.created_by
       JOIN subjects s ON s.id = a.subject_id
       JOIN classes c ON c.id = a.class_id
       JOIN schools sc ON sc.id = c.school_id
       WHERE a.class_id = $1
       ORDER BY a.due_date ASC, a.id DESC`,
      [classId]
    );
    res.json({ assessments: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/assessments", requireLogin, async (req, res, next) => {
  try {
    const classId = positiveInt(req.body.classId);
    const subjectId = positiveInt(req.body.subjectId);
    const title = textValue(req.body.title, 180);
    const dueDate = typeof req.body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate) ? req.body.dueDate : null;
    const details = typeof req.body.details === "string" ? req.body.details.trim().slice(0, 3000) : "";
    if (!classId || !subjectId || !title || !dueDate) {
      return res.status(400).json({ error: "학급, 과목, 제목, 날짜를 모두 입력해 주세요." });
    }
    const result = await db.query(
      "INSERT INTO assessments (class_id, subject_id, title, details, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, class_id, subject_id, title, details, to_char(due_date, 'YYYY-MM-DD') AS due_date, created_by",
      [classId, subjectId, title, details, dueDate, req.session.user.id]
    );
    res.status(201).json({ assessment: result.rows[0] });
  } catch (error) {
    if (error.code === "P0001") return res.status(400).json({ error: "학급과 과목은 같은 학교에 속해야 합니다." });
    next(error);
  }
});

app.put("/api/assessments/:id", requireLogin, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const classId = positiveInt(req.body.classId);
    const subjectId = positiveInt(req.body.subjectId);
    const title = textValue(req.body.title, 180);
    const dueDate = typeof req.body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate) ? req.body.dueDate : null;
    const details = typeof req.body.details === "string" ? req.body.details.trim().slice(0, 3000) : "";
    if (!id || !classId || !subjectId || !title || !dueDate) return res.status(400).json({ error: "입력 내용을 확인해 주세요." });
    const result = await db.query(
      "UPDATE assessments SET class_id=$1, subject_id=$2, title=$3, details=$4, due_date=$5, updated_at=NOW() WHERE id=$6 AND created_by=$7 RETURNING id, class_id, subject_id, title, details, to_char(due_date, 'YYYY-MM-DD') AS due_date, created_by",
      [classId, subjectId, title, details, dueDate, id, req.session.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "일정을 찾을 수 없거나 수정 권한이 없습니다." });
    res.json({ assessment: result.rows[0] });
  } catch (error) {
    if (error.code === "P0001") return res.status(400).json({ error: "학급과 과목은 같은 학교에 속해야 합니다." });
    next(error);
  }
});

app.delete("/api/assessments/:id", requireLogin, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: "일정 ID가 올바르지 않습니다." });
    const result = await db.query("DELETE FROM assessments WHERE id=$1 AND created_by=$2", [id, req.session.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: "일정을 찾을 수 없거나 삭제 권한이 없습니다." });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "요청한 API를 찾을 수 없습니다." });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
});

app.listen(port, () => console.log(`Assessment Calendar server listening on port ${port}`));
