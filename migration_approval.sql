-- Apply once to an existing database before deploying the approval workflow.
ALTER TABLE assessments ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'approved';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessments_status_check') THEN
    ALTER TABLE assessments ADD CONSTRAINT assessments_status_check CHECK (status = 'approved');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS school_admins (
  school_id BIGINT PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
