require('dotenv').config();

// ------------------------------------------------------------
// Fail fast and clearly if required env vars are missing, rather
// than letting jwt.sign() or the db pool throw a cryptic error
// deep inside a request handler later.
// ------------------------------------------------------------
const REQUIRED_ENV_VARS = ['JWT_SECRET', 'DATABASE_URL'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingEnvVars.join(', ')}`);
  console.error('Add them to your .env file before starting the server. See README.md.');
  process.exit(1);
}

const { authenticate, officerOnly } = require('./middleware');
const express = require('express');
const cors = require('cors');
const authRoutes = require('./auth');
const pool = require('./db');   // <-- import the shared connection

const app = express();
app.use(cors());
app.use(express.json());
app.use('/auth', authRoutes);   // now /auth/register and /auth/login exist

// Test route (keep this)
app.get('/', (req, res) => {
  res.json({ message: 'T&P Portal backend is running!' });
});

const PORT = process.env.PORT || 5000;

// ------------------------------------------------------------
// Shared helper: given a company row and a student_profiles row,
// work out eligibility + a human-readable reason.
// Used by both GET /companies/eligible and POST /applications,
// so the two never disagree about who qualifies.
// ------------------------------------------------------------
function checkEligibility(company, profile) {
  // Quota drives aren't rule-checked — everyone can opt in
  if (company.eligibility_type === 'quota') {
    return { eligible: null, mode: 'opt-in', reason: null };
  }

  if (!profile) {
    return {
      eligible: false,
      mode: 'rule',
      reason: 'Complete your student profile to check eligibility'
    };
  }

  const reasons = [];

  if (profile.cgpa === null || profile.cgpa < company.min_cgpa) {
    reasons.push(`Requires CGPA ${company.min_cgpa}, yours is ${profile.cgpa ?? 'not set'}`);
  }

  if (company.allowed_branches) {
    const allowed = company.allowed_branches.split(',').map(b => b.trim().toUpperCase());
    if (!profile.branch || !allowed.includes(profile.branch.toUpperCase())) {
      reasons.push(`Open to ${company.allowed_branches} only, yours is ${profile.branch ?? 'not set'}`);
    }
  }

  if (profile.backlogs > company.max_backlogs) {
    reasons.push(`Max ${company.max_backlogs} backlogs allowed, you have ${profile.backlogs}`);
  }

  return {
    eligible: reasons.length === 0,
    mode: 'rule',
    reason: reasons.length ? reasons.join('; ') : null
  };
}

// ---------- STUDENT PROFILE ----------

// Student views their own profile
app.get('/profile', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM student_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Profile not set up yet' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile', detail: err.message });
  }
});

// Student creates or updates their own profile (upsert — one row per user)
app.put('/profile', authenticate, async (req, res) => {
  try {
    const { cgpa, branch, backlogs, resume_url } = req.body;
    const result = await pool.query(
      `INSERT INTO student_profiles (user_id, cgpa, branch, backlogs, resume_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET cgpa = EXCLUDED.cgpa,
             branch = EXCLUDED.branch,
             backlogs = EXCLUDED.backlogs,
             resume_url = EXCLUDED.resume_url
       RETURNING *`,
      [req.user.id, cgpa ?? null, branch ?? null, backlogs ?? 0, resume_url ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save profile', detail: err.message });
  }
});

// ---------- COMPANIES ----------

// Officer-only: raw list of every company, no eligibility logic applied.
app.get('/companies', authenticate, officerOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM companies ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch companies', detail: err.message });
  }
});

// ---------- COMPANIES (student-facing, eligibility-aware) ----------
// IMPORTANT: this must be registered BEFORE /companies/:id.
// Express matches routes in registration order, and ':id' is a wildcard
// that would otherwise swallow the literal path "/companies/eligible"
// (treating "eligible" as the :id value) if it came first.

// Student view: every company, with eligible/locked + reason computed
// against the logged-in student's profile.
app.get('/companies/eligible', authenticate, async (req, res) => {
  try {
    const studentId = req.user.id;

    const profileResult = await pool.query(
      'SELECT cgpa, branch, backlogs FROM student_profiles WHERE user_id = $1',
      [studentId]
    );
    const profile = profileResult.rows[0] || null;

    const companiesResult = await pool.query('SELECT * FROM companies ORDER BY id');

    const companies = companiesResult.rows.map((company) => ({
      ...company,
      ...checkEligibility(company, profile)
    }));

    res.json(companies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch companies', detail: err.message });
  }
});

// Single company detail. Officers get the raw row; students get eligibility
// computed against their own profile, same as the /companies/eligible list.
app.get('/companies/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const companyResult = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
    if (companyResult.rows.length === 0)
      return res.status(404).json({ error: 'Company not found' });
    const company = companyResult.rows[0];

    if (req.user.role === 'officer') {
      return res.json(company);
    }

    const profileResult = await pool.query(
      'SELECT cgpa, branch, backlogs FROM student_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const profile = profileResult.rows[0] || null;
    const elig = checkEligibility(company, profile);
    res.json({ ...company, ...elig });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch company', detail: err.message });
  }
});

// Officer adds a company (protected: must be logged in AND an officer)
app.post('/companies', authenticate, officerOnly, async (req, res) => {
  try {
    const { name, role_offered, package: pkg, job_description,
            eligibility_type, min_cgpa, allowed_branches, max_backlogs,
            quota_size, visit_date } = req.body;
    const result = await pool.query(
      `INSERT INTO companies
        (name, role_offered, package, job_description, eligibility_type,
         min_cgpa, allowed_branches, max_backlogs, quota_size, visit_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, role_offered, pkg, job_description, eligibility_type ?? 'rule',
       min_cgpa ?? 0, allowed_branches, max_backlogs ?? 99, quota_size, visit_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add company', detail: err.message });
  }
});

// Officer edits a company
app.put('/companies/:id', authenticate, officerOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role_offered, package: pkg, job_description,
            eligibility_type, min_cgpa, allowed_branches, max_backlogs,
            quota_size, visit_date, status } = req.body;
    const result = await pool.query(
      `UPDATE companies SET
         name = COALESCE($1, name),
         role_offered = COALESCE($2, role_offered),
         package = COALESCE($3, package),
         job_description = COALESCE($4, job_description),
         eligibility_type = COALESCE($5, eligibility_type),
         min_cgpa = COALESCE($6, min_cgpa),
         allowed_branches = COALESCE($7, allowed_branches),
         max_backlogs = COALESCE($8, max_backlogs),
         quota_size = COALESCE($9, quota_size),
         visit_date = COALESCE($10, visit_date),
         status = COALESCE($11, status)
       WHERE id = $12 RETURNING *`,
      [name, role_offered, pkg, job_description, eligibility_type,
       min_cgpa, allowed_branches, max_backlogs, quota_size, visit_date, status, id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update company', detail: err.message });
  }
});

// Officer deletes a company
app.delete('/companies/:id', authenticate, officerOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Company not found' });
    res.json({ message: 'Company deleted', id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete company', detail: err.message });
  }
});

// ---------- STUDENTS ----------

// Officer views all students (protected, officer-only)
app.get('/students', authenticate, officerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, p.cgpa, p.branch, p.backlogs
       FROM users u
       LEFT JOIN student_profiles p ON p.user_id = u.id
       WHERE u.role = 'student' ORDER BY u.id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch students', detail: err.message });
  }
});

// ---------- APPLICATIONS ----------

// Student applies to / opts into a company.
// Rule-based drives are re-checked server-side (never trust the frontend
// button state) and rejected if the student doesn't qualify.
// Quota drives don't get a rule check — they go in as 'interested'.
app.post('/applications', authenticate, async (req, res) => {
  try {
    const { company_id } = req.body;
    const student_id = req.user.id;

    const companyResult = await pool.query('SELECT * FROM companies WHERE id = $1', [company_id]);
    if (companyResult.rows.length === 0)
      return res.status(404).json({ error: 'Company not found' });
    const company = companyResult.rows[0];

    let status;

    if (company.eligibility_type === 'quota') {
      status = 'interested';
    } else {
      const profileResult = await pool.query(
        'SELECT cgpa, branch, backlogs FROM student_profiles WHERE user_id = $1',
        [student_id]
      );
      const profile = profileResult.rows[0] || null;
      const elig = checkEligibility(company, profile);

      if (!elig.eligible) {
        return res.status(403).json({ error: 'Not eligible for this drive', reason: elig.reason });
      }
      status = 'applied';
    }

    const result = await pool.query(
      `INSERT INTO applications (student_id, company_id, status)
       VALUES ($1, $2, $3) RETURNING *`,
      [student_id, company_id, status]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'You already applied to this company' });
    console.error(err);
    res.status(500).json({ error: 'Failed to apply', detail: err.message });
  }
});

// View applications — a student sees only their own; an officer sees all
app.get('/applications', authenticate, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'officer') {
      result = await pool.query(
        `SELECT a.id, u.name AS student, c.name AS company, a.status, a.applied_at
         FROM applications a
         JOIN users u ON a.student_id = u.id
         JOIN companies c ON a.company_id = c.id
         ORDER BY a.id`
      );
    } else {
      result = await pool.query(
        `SELECT a.id, c.name AS company, a.status, a.applied_at
         FROM applications a
         JOIN companies c ON a.company_id = c.id
         WHERE a.student_id = $1 ORDER BY a.id`,
        [req.user.id]
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch applications', detail: err.message });
  }
});

// Officer updates an application's status.
// Also drops a notification for the affected student so the "closed loop"
// from the design doc (status change -> alert) actually happens.
app.put('/applications/:id', authenticate, officerOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE applications SET status = $1 WHERE id = $2
       RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Application not found' });

    const application = result.rows[0];

    // Look up the company name so the notification message is readable
    const companyResult = await pool.query('SELECT name FROM companies WHERE id = $1', [application.company_id]);
    const companyName = companyResult.rows[0]?.name || 'a company';

    await pool.query(
      `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
      [application.student_id, `Your application to ${companyName} is now "${status}".`]
    );

    res.json(application);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status', detail: err.message });
  }
});

// ---------- NOTIFICATIONS ----------

// Logged-in user views their own notifications, newest first
app.get('/notifications', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications', detail: err.message });
  }
});

// Mark a single notification as read
app.put('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Notification not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update notification', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});