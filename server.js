const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const cors    = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ─── PostgreSQL Connection ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@192.168.1.156:5432/Indian_Railway',
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PG client error:', err.message);
});

// ─── Create Tables (attendance + location) ─────────────────────────────────
// The "users" table already exists in your DB — we only create the new ones.
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        clock_in      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        clock_out     TIMESTAMPTZ DEFAULT NULL,
        clock_in_lat  DOUBLE PRECISION DEFAULT NULL,
        clock_in_lng  DOUBLE PRECISION DEFAULT NULL,
        clock_out_lat DOUBLE PRECISION DEFAULT NULL,
        clock_out_lng DOUBLE PRECISION DEFAULT NULL,
        total_minutes INTEGER DEFAULT NULL,
        notes         TEXT DEFAULT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS location (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id  INTEGER DEFAULT NULL REFERENCES attendance(id) ON DELETE SET NULL,
        lat         DOUBLE PRECISION NOT NULL,
        lng         DOUBLE PRECISION NOT NULL,
        accuracy    DOUBLE PRECISION DEFAULT NULL,
        speed       DOUBLE PRECISION DEFAULT NULL,
        heading     DOUBLE PRECISION DEFAULT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Indexes for fast lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_user_clock_in
        ON attendance (user_id, clock_in DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_location_user_recorded
        ON location (user_id, recorded_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_location_session_recorded
        ON location (session_id, recorded_at ASC);
    `);

    console.log('✅ PostgreSQL connected & tables ready');
  } finally {
    client.release();
  }
}

initDB().catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});

// ─── Seed Default Admin ────────────────────────────────────────────────────
// Only runs if no admin row exists yet. Uses emp_id as the login identifier.
async function seedAdmin() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (rows.length === 0) {
    const hash = await bcrypt.hash('Admin@1234', 10);
    await pool.query(
      `INSERT INTO users (emp_id, full_name, password, role, department)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (emp_id) DO NOTHING`,
      ['ADMIN001', 'Admin', hash, 'admin', 'Management']
    );
    console.log('🌱 Default admin → emp_id: ADMIN001 / Admin@1234');
  }
}
initDB().then(seedAdmin).catch(() => {});

// ─── Auth Middleware ───────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'supersecret');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────

// Register
// emp_id acts as the unique login identifier (same as your existing schema)
app.post('/api/register', async (req, res) => {
  try {
    const { emp_id, full_name, password, role = 'employee', department, sub_team } = req.body;
    if (!emp_id || !full_name || !password)
      return res.status(400).json({ error: 'Missing fields: emp_id, full_name, password required' });

    const exists = await pool.query(`SELECT id FROM users WHERE emp_id = $1`, [emp_id]);
    if (exists.rows.length > 0)
      return res.status(400).json({ error: 'emp_id already registered' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (emp_id, full_name, password, role, department, sub_team)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, emp_id, full_name, role, department, sub_team`,
      [emp_id, full_name, hash, role, department || null, sub_team || null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login — uses emp_id + password
app.post('/api/login', async (req, res) => {
  try {
    const { emp_id, password } = req.body;
    if (!emp_id || !password)
      return res.status(400).json({ error: 'emp_id and password required' });

    const { rows } = await pool.query(`SELECT * FROM users WHERE emp_id = $1`, [emp_id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, name: user.full_name, role: user.role, emp_id: user.emp_id },
      process.env.JWT_SECRET || 'supersecret',
      { expiresIn: '12h' }
    );
    res.json({
      token,
      user: {
        id: user.id, emp_id: user.emp_id, name: user.full_name,
        role: user.role, department: user.department, sub_team: user.sub_team,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Clock In ───────────────────────────────────────────────────────────────
app.post('/api/attendance/clock-in', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;

    // Check for open session
    const open = await pool.query(
      `SELECT id FROM attendance WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`,
      [req.user.id]
    );
    if (open.rows.length > 0)
      return res.status(400).json({ error: 'Already clocked in' });

    const { rows } = await pool.query(
      `INSERT INTO attendance (user_id, clock_in, clock_in_lat, clock_in_lng)
       VALUES ($1, NOW(), $2, $3)
       RETURNING id, clock_in`,
      [req.user.id, lat ?? null, lng ?? null]
    );
    const session = rows[0];

    // Save first location ping
    await pool.query(
      `INSERT INTO location (user_id, session_id, lat, lng, accuracy)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, session.id, lat, lng, accuracy ?? null]
    );

    res.json({ session_id: session.id, clocked_in: session.clock_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clock Out ──────────────────────────────────────────────────────────────
app.post('/api/attendance/clock-out', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    const open = await pool.query(
      `SELECT id, clock_in FROM attendance WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`,
      [req.user.id]
    );
    if (open.rows.length === 0)
      return res.status(400).json({ error: 'Not clocked in' });

    const { id: sessionId, clock_in } = open.rows[0];
    const totalMinutes = Math.round((Date.now() - new Date(clock_in).getTime()) / 60000);

    const { rows } = await pool.query(
      `UPDATE attendance
       SET clock_out = NOW(), clock_out_lat = $1, clock_out_lng = $2,
           total_minutes = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [lat ?? null, lng ?? null, totalMinutes, sessionId]
    );

    // Delete ephemeral location pings for this user (same as original behavior)
    await pool.query(`DELETE FROM location WHERE user_id = $1`, [req.user.id]);

    res.json({ session: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GPS Ping ───────────────────────────────────────────────────────────────
app.post('/api/location', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy, speed, heading } = req.body;

    const session = await pool.query(
      `SELECT id FROM attendance WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`,
      [req.user.id]
    );
    const sessionId = session.rows[0]?.id ?? null;

    await pool.query(
      `INSERT INTO location (user_id, session_id, lat, lng, accuracy, speed, heading)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, sessionId, lat, lng, accuracy ?? null, speed ?? null, heading ?? null]
    );
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── My Attendance History ──────────────────────────────────────────────────
app.get('/api/attendance/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.full_name AS name
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1
       ORDER BY a.clock_in DESC
       LIMIT 30`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Live Locations ──────────────────────────────────────────────────
// Returns the latest ping per user — only users who are currently clocked in
// appear here because location rows are wiped on clock-out.
app.get('/api/admin/live-locations', auth, admin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (l.user_id)
        l.user_id,
        u.full_name        AS name,
        l.lat, l.lng,
        l.accuracy, l.speed, l.heading,
        l.recorded_at,
        l.session_id,
        a.clock_in,
        a.clock_in_lat,
        a.clock_in_lng
      FROM location l
      JOIN users      u ON u.id = l.user_id
      LEFT JOIN attendance a ON a.id = l.session_id
      ORDER BY l.user_id, l.recorded_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: All Attendance ──────────────────────────────────────────────────
// Supports ?date=YYYY-MM-DD and ?user_id=123
app.get('/api/admin/attendance', auth, admin, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    const conditions = [];
    const params = [];

    if (user_id) {
      params.push(user_id);
      conditions.push(`a.user_id = $${params.length}`);
    }
    if (date) {
      params.push(date);
      conditions.push(`a.clock_in::date = $${params.length}::date`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT a.*, u.full_name AS name, u.emp_id, u.department, u.sub_team
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.clock_in DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: All Users ───────────────────────────────────────────────────────
app.get('/api/admin/users', auth, admin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, emp_id, full_name, role, department, sub_team, created_at
       FROM users
       ORDER BY full_name ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Location Trail by Session ──────────────────────────────────────
app.get('/api/admin/location-trail/:session_id', auth, admin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM location WHERE session_id = $1 ORDER BY recorded_at ASC`,
      [req.params.session_id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Location Trail by User (today) ─────────────────────────────────
app.get('/api/admin/location-trail/user/:user_id', auth, admin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM location
       WHERE user_id = $1 AND recorded_at >= CURRENT_DATE
       ORDER BY recorded_at ASC`,
      [req.params.user_id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
