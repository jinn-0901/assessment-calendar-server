-- Run this file once against a new PostgreSQL database.
-- PostgreSQL creates tables in dependency order.

CREATE TABLE IF NOT EXISTS schools (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  region VARCHAR(120) NOT NULL DEFAULT '',
  neis_office_code VARCHAR(10),
  neis_school_code VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, region)
);

CREATE TABLE IF NOT EXISTS classes (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  grade SMALLINT NOT NULL CHECK (grade BETWEEN 1 AND 12),
  class_number SMALLINT NOT NULL CHECK (class_number BETWEEN 1 AND 99),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, grade, class_number)
);

CREATE TABLE IF NOT EXISTS subjects (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  display_name VARCHAR(80) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assessments (
  id BIGSERIAL PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  title VARCHAR(180) NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  due_date DATE NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'approved' CHECK (status IN ('approved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);
CREATE INDEX IF NOT EXISTS idx_subjects_school ON subjects(school_id);
CREATE INDEX IF NOT EXISTS idx_assessments_class_date ON assessments(class_id, due_date);
CREATE INDEX IF NOT EXISTS idx_assessments_subject ON assessments(subject_id);
CREATE INDEX IF NOT EXISTS idx_assessments_creator ON assessments(created_by);

-- Keep subject and class attached to the same school.
CREATE OR REPLACE FUNCTION validate_assessment_school()
RETURNS TRIGGER AS $$
DECLARE
  class_school BIGINT;
  subject_school BIGINT;
BEGIN
  SELECT school_id INTO class_school FROM classes WHERE id = NEW.class_id;
  SELECT school_id INTO subject_school FROM subjects WHERE id = NEW.subject_id;

  IF class_school IS NULL OR subject_school IS NULL OR class_school <> subject_school THEN
    RAISE EXCEPTION 'Class and subject must belong to the same school';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_assessment_school ON assessments;
CREATE TRIGGER trg_validate_assessment_school
BEFORE INSERT OR UPDATE ON assessments
FOR EACH ROW EXECUTE FUNCTION validate_assessment_school();


-- School-scoped administrator credentials. Students do not need accounts.
CREATE TABLE IF NOT EXISTS school_admins (
  school_id BIGINT PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- New schedules and edits are invisible until a school admin approves them.
CREATE TABLE IF NOT EXISTS assessment_requests (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assessment_id BIGINT REFERENCES assessments(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('create','edit')),
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_school_admin BIGINT REFERENCES schools(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_assessment_requests_school_status ON assessment_requests(school_id,status,created_at);


-- NEIS school codes: also supports databases created before these columns existed.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS neis_office_code VARCHAR(10);
ALTER TABLE schools ADD COLUMN IF NOT EXISTS neis_school_code VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_neis_codes
  ON schools(neis_office_code, neis_school_code)
  WHERE neis_office_code IS NOT NULL AND neis_school_code IS NOT NULL;
