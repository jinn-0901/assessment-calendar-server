-- Run this file against the Render PostgreSQL database.
-- PostgreSQL creates tables in dependency order.

CREATE TABLE IF NOT EXISTS schools (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  region VARCHAR(120) NOT NULL DEFAULT '',
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
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
