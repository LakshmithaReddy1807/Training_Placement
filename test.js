// test.js
// One end-to-end script exercising every route in the T&P Portal API.
// Run with: node test.js
// Requires the server to already be running (node server.js) in another terminal.

const BASE = 'http://localhost:5000';

// Small helper so every fetch call doesn't need its own try/catch and log line
async function call(label, url, options = {}) {
  const res = await fetch(`${BASE}${url}`, options);
  const body = await res.json().catch(() => ({}));
  console.log(`[${res.status}] ${label}:`, body);
  return { status: res.status, body };
}

function authHeader(token) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function run() {
  console.log('\n================ AUTH ================\n');

  // ---- Officer: register (safe to re-run, 409 if it already exists) ----
  await call('Officer register', '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Officer', email: 'officer@college.edu',
      password: 'mypassword', role: 'officer'
    })
  });

  // ---- Officer: bad role should 400, not 500 ----
  await call('Register with invalid role (expect 400)', '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad Role', email: 'badrole@college.edu',
      password: 'mypassword', role: 'admin'
    })
  });

  // ---- Officer: login ----
  let { body: officerLogin } = await call('Officer login', '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'officer@college.edu', password: 'mypassword' })
  });
  const officerAuth = authHeader(officerLogin.token);

  // ---- Student: register + login ----
  await call('Student register', '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Student', email: 'student@college.edu',
      password: 'mypassword', role: 'student'
    })
  });

  let { body: studentLogin } = await call('Student login', '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'student@college.edu', password: 'mypassword' })
  });
  const studentAuth = authHeader(studentLogin.token);

  console.log('\n================ COMPANIES (officer) ================\n');

  // ---- Officer adds a rule-based company ----
  const { body: wipro } = await call('Add company (rule)', '/companies', {
    method: 'POST', headers: officerAuth,
    body: JSON.stringify({
      name: 'Wipro', role_offered: 'Engineer', package: 5.5,
      eligibility_type: 'rule', min_cgpa: 6.0, allowed_branches: 'CSE,IT', max_backlogs: 0
    })
  });

  // ---- Officer adds a quota company ----
  const { body: tcs } = await call('Add company (quota)', '/companies', {
    method: 'POST', headers: officerAuth,
    body: JSON.stringify({
      name: 'TCS Ninja', role_offered: 'Graduate Trainee', package: 4.5,
      eligibility_type: 'quota', quota_size: 50
    })
  });

  // ---- Officer views raw company list ----
  await call('Officer — all companies', '/companies', { headers: officerAuth });

  // ---- Officer edits the Wipro listing ----
  await call('Edit company', `/companies/${wipro.id}`, {
    method: 'PUT', headers: officerAuth,
    body: JSON.stringify({ package: 6.0 })
  });

  console.log('\n================ STUDENT PROFILE ================\n');

  // ---- Before setting a profile: everything should be locked ----
  await call('Eligible view BEFORE profile', '/companies/eligible', { headers: studentAuth });

  // ---- Student sets their profile — deliberately below Wipro's CGPA bar ----
  await call('Set profile (low CGPA)', '/profile', {
    method: 'PUT', headers: studentAuth,
    body: JSON.stringify({ cgpa: 6.4, branch: 'IT', backlogs: 1 })
  });

  await call('Get own profile', '/profile', { headers: studentAuth });

  // ---- After profile: Wipro should be locked (needs 6.0 min but max_backlogs 0, student has 1) ----
  await call('Eligible view AFTER profile (expect Wipro locked)', '/companies/eligible', { headers: studentAuth });

  console.log('\n================ APPLICATIONS ================\n');

  // ---- Student tries to apply to Wipro while ineligible — expect 403, no row created ----
  await call('Apply to Wipro while ineligible (expect 403)', '/applications', {
    method: 'POST', headers: studentAuth,
    body: JSON.stringify({ company_id: wipro.id })
  });

  // ---- Student opts into the quota drive — always allowed, goes in as 'interested' ----
  await call('Opt into TCS quota drive (expect status: interested)', '/applications', {
    method: 'POST', headers: studentAuth,
    body: JSON.stringify({ company_id: tcs.id })
  });

  // ---- Fix the profile so Wipro becomes eligible, then apply successfully ----
  await call('Update profile (fix backlogs)', '/profile', {
    method: 'PUT', headers: studentAuth,
    body: JSON.stringify({ cgpa: 6.4, branch: 'IT', backlogs: 0 })
  });

  const { body: wiproApp } = await call('Apply to Wipro now eligible (expect status: applied)', '/applications', {
    method: 'POST', headers: studentAuth,
    body: JSON.stringify({ company_id: wipro.id })
  });

  // ---- Duplicate apply should 409 ----
  await call('Duplicate apply (expect 409)', '/applications', {
    method: 'POST', headers: studentAuth,
    body: JSON.stringify({ company_id: wipro.id })
  });

  // ---- Student views their own applications ----
  await call('Student — my applications', '/applications', { headers: studentAuth });

  // ---- Officer views all applications ----
  await call('Officer — all applications', '/applications', { headers: officerAuth });

  console.log('\n================ STATUS UPDATE + NOTIFICATIONS ================\n');

  // ---- Officer shortlists the student for Wipro ----
  await call('Officer shortlists Wipro application', `/applications/${wiproApp.id}`, {
    method: 'PUT', headers: officerAuth,
    body: JSON.stringify({ status: 'shortlisted' })
  });

  // ---- Student should now have a notification about it ----
  await call('Student — notifications', '/notifications', { headers: studentAuth });

  console.log('\n================ ACCESS CONTROL CHECKS ================\n');

  // ---- Student hitting officer-only routes should be rejected ----
  await call('Student hits /companies (expect 403)', '/companies', { headers: studentAuth });
  await call('Student hits /students (expect 403)', '/students', { headers: studentAuth });

  console.log('\n================ CLEANUP (officer deletes TCS) ================\n');

  await call('Delete company', `/companies/${tcs.id}`, {
    method: 'DELETE', headers: officerAuth
  });

  console.log('\nDone.\n');
}

run().catch((err) => console.error('Test run failed:', err));