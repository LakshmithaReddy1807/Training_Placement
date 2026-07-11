const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const router = express.Router();

const VALID_ROLES = ['student', 'officer'];

// REGISTER
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role)
      return res.status(400).json({ error: 'All fields are required' });

    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });

    const hash = await bcrypt.hash(password, 10);          // scramble the password
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, name, role',
      [name, email, hash, role]
    );
    res.status(201).json({ message: 'User registered', user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error(err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0)
      return res.status(401).json({ error: 'Invalid email or password' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);   // check password
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    // create the JWT — it carries the user's id and role
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ message: 'Login successful', token, user: { id: user.id, name: user.name, role: user.role } });
 } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

module.exports = router;