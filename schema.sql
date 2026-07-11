-- ============================================================
--  Training & Placement Portal — Database Schema (PostgreSQL)
--  MVP data model. Run top to bottom; order matters because
--  of foreign keys (a table must exist before another links to it).
-- ============================================================

-- Clean slate (safe to re-run during development)
DROP TABLE IF EXISTS notifications     CASCADE;
DROP TABLE IF EXISTS applications       CASCADE;
DROP TABLE IF EXISTS companies          CASCADE;
DROP TABLE IF EXISTS student_profiles   CASCADE;
DROP TABLE IF EXISTS users              CASCADE;

-- ------------------------------------------------------------
-- 1. USERS  — both students and officers; role tells them apart
-- ------------------------------------------------------------
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(10)  NOT NULL CHECK (role IN ('student', 'officer')),
    created_at    TIMESTAMP    DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 2. STUDENT_PROFILES — academic data; one per student (1:1)
--    eligibility rules are checked against this table
-- ------------------------------------------------------------
CREATE TABLE student_profiles (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    cgpa       NUMERIC(4,2) CHECK (cgpa >= 0 AND cgpa <= 10),
    branch     VARCHAR(50),
    backlogs   INTEGER DEFAULT 0 CHECK (backlogs >= 0),
    resume_url VARCHAR(255)
);

-- ------------------------------------------------------------
-- 3. COMPANIES — one row per recruitment drive
--    eligibility_type drives the whole rule-vs-quota logic
-- ------------------------------------------------------------
CREATE TABLE companies (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(150) NOT NULL,
    role_offered     VARCHAR(100),
    package          NUMERIC(6,2),               -- LPA
    job_description  TEXT,
    eligibility_type VARCHAR(10) NOT NULL DEFAULT 'rule'
                     CHECK (eligibility_type IN ('rule', 'quota')),
    min_cgpa         NUMERIC(4,2) DEFAULT 0,      -- used for rule drives
    allowed_branches VARCHAR(255),                -- e.g. 'CSE,IT,ECE'
    max_backlogs     INTEGER DEFAULT 99,
    quota_size       INTEGER,                     -- used for quota drives only
    visit_date       DATE,
    status           VARCHAR(10) DEFAULT 'open'
                     CHECK (status IN ('open', 'closed'))
);

-- ------------------------------------------------------------
-- 4. APPLICATIONS — the bridge: links one student to one company
--    carries the status both actors track
-- ------------------------------------------------------------
CREATE TABLE applications (
    id         SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status     VARCHAR(15) NOT NULL DEFAULT 'applied'
               CHECK (status IN ('interested','applied','shortlisted',
                                 'interview','selected','rejected',
                                 'not_selected','not_eligible')),
    rank       INTEGER,                            -- ordering for quota drives
    applied_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (student_id, company_id)                -- no duplicate applications
);

-- ------------------------------------------------------------
-- 5. NOTIFICATIONS — many per user (1:N)
-- ------------------------------------------------------------
CREATE TABLE notifications (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message    TEXT NOT NULL,
    is_read    BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Helpful indexes for the most common lookups
CREATE INDEX idx_applications_student ON applications(student_id);
CREATE INDEX idx_applications_company ON applications(company_id);
CREATE INDEX idx_notifications_user   ON notifications(user_id);


-- ============================================================
--  SEED DATA
--  Users are intentionally NOT seeded here: password_hash needs
--  a real bcrypt hash, and hardcoding one in SQL is easy to get
--  out of sync with whatever bcrypt salt rounds the app uses.
--  Register real users through POST /auth/register instead
--  (see test.js) — that guarantees the hash always matches
--  what the login route expects.
--
--  Companies have no password concerns, so they're seeded here
--  for convenience.
-- ============================================================
INSERT INTO companies
    (name, role_offered, package, eligibility_type, min_cgpa, allowed_branches, quota_size, visit_date)
VALUES
    ('Infosys', 'Systems Engineer', 6.00, 'rule',  7.00, 'CSE,IT', NULL, '2026-08-15'),
    ('TCS',     'Graduate Trainee', 5.00, 'quota', 0.00, 'CSE,IT,ECE', 100, '2026-09-01');

-- ============================================================
--  SAMPLE QUERIES — try these to see the model in action
--  (run after you've registered some real users via the API)
-- ============================================================

-- Who applied to which company, and current status?
-- SELECT u.name, c.name AS company, a.status
-- FROM applications a
-- JOIN users u     ON a.student_id = u.id
-- JOIN companies c ON a.company_id = c.id;

-- Which students are ELIGIBLE for a given rule-based drive (Infosys, id=1)?
-- SELECT u.name, p.cgpa, p.branch
-- FROM users u
-- JOIN student_profiles p ON p.user_id = u.id
-- JOIN companies c ON c.id = 1
-- WHERE u.role = 'student'
--   AND p.cgpa >= c.min_cgpa
--   AND p.backlogs <= c.max_backlogs;