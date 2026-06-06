const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());  

// ─── MongoDB Connection ────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, { dbName: 'login_user' })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ─── Schemas & Models ──────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password:      { type: String, default: null },   // legacy plain-text (PostgreSQL migration)
  password_hash: { type: String, default: null },   // bcrypt
  role:          { type: String, enum: ['admin', 'employee'], default: 'employee' },
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clock_in:      { type: Date, required: true },
  clock_out:     { type: Date, default: null },
  clock_in_lat:  { type: Number, default: null },
  clock_in_lng:  { type: Number, default: null },
  clock_out_lat: { type: Number, default: null },
  clock_out_lng: { type: Number, default: null },
  total_minutes: { type: Number, default: null },
  notes:         { type: String, default: null },
}, { timestamps: true });

const locationSchema = new mongoose.Schema({
  user_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  session_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
  lat:         { type: Number, required: true },
  lng:         { type: Number, required: true },
  accuracy:    { type: Number, default: null },
  speed:       { type: Number, default: null },     // m/s from device
  heading:     { type: Number, default: null },     // degrees 0-360
  recorded_at: { type: Date, default: Date.now },
});
const routeGeoJSONSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',       required: true },
  session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true },
  geojson:    { type: mongoose.Schema.Types.Mixed,    required: true },
  metadata: {
    ping_count:    Number,
    point_count:   Number,
    total_minutes: Number,
    clock_in:      Date,
    clock_out:     Date,
  },
  saved_at: { type: Date, default: Date.now },
});
routeGeoJSONSchema.index({ session_id: 1 }, { unique: true });

const RouteGeoJSON = mongoose.model('RouteGeoJSON', routeGeoJSONSchema);
attendanceSchema.index({ user_id: 1, clock_in: -1 });
locationSchema.index({ user_id: 1, recorded_at: -1 });
locationSchema.index({ session_id: 1, recorded_at: 1 });

const User       = mongoose.model('User',       userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Location = mongoose.model('Location', locationSchema, 'locations');

// ── buildAndSaveGeoJSON ───────────────────────────────────────────────────────
// Reads all location pings for a session, builds a GeoJSON FeatureCollection,
// and upserts it into the RouteGeoJSON collection.
async function buildAndSaveGeoJSON(session, user) {
  const pings = await Location.find({ session_id: session._id })
    .sort({ recorded_at: 1 }).lean();

  const coords = [];
  if (session.clock_in_lat && session.clock_in_lng)
    coords.push([session.clock_in_lng, session.clock_in_lat]);

  pings.forEach(p => coords.push([p.lng, p.lat]));

  if (session.clock_out_lat && session.clock_out_lng)
    coords.push([session.clock_out_lng, session.clock_out_lat]);

  if (coords.length < 2) return null;

  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {
          employee_name:  user?.name  ?? null,
          employee_email: user?.email ?? null,
          clock_in:       session.clock_in,
          clock_out:      session.clock_out  ?? null,
          total_minutes:  session.total_minutes ?? null,
          ping_count:     pings.length,
          point_count:    coords.length,
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: coords[0] },
        properties: { label: "Clock In",  time: session.clock_in, marker: "green" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: coords[coords.length - 1] },
        properties: { label: "Clock Out", time: session.clock_out ?? "Active", marker: "red" },
      },
    ],
  };

  await RouteGeoJSON.findOneAndUpdate(
    { session_id: session._id },
    {
      user_id:    session.user_id,
      session_id: session._id,
      geojson,
      metadata: {
        ping_count:    pings.length,
        point_count:   coords.length,
        total_minutes: session.total_minutes ?? null,
        clock_in:      session.clock_in,
        clock_out:     session.clock_out ?? null,
      },
      saved_at: new Date(),
    },
    { upsert: true, new: true }
  );

  return geojson;
}
// ─── Seed default admin ────────────────────────────────────────────────────
async function seedAdmin() {
  const exists = await User.findOne({ email: 'admin@company.com' });
  if (!exists) {
    const hash = await bcrypt.hash('Admin@1234', 10);
    await User.create({ name: 'Admin', email: 'admin@company.com', password_hash: hash, role: 'admin' });
    console.log('🌱 Default admin → admin@company.com / Admin@1234');
  }
}
mongoose.connection.once('open', seedAdmin);

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
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role = 'employee' } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Missing fields' });
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password_hash: hash, role });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    let ok = false;
    if (user.password && typeof user.password === 'string') {
      ok = password === user.password;                              // legacy
    } else if (user.password_hash && typeof user.password_hash === 'string') {
      ok = await bcrypt.compare(password, user.password_hash);     // bcrypt
    }
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user._id.toString(), name: user.name, role: user.role },
      process.env.JWT_SECRET || 'supersecret',
      { expiresIn: '12h' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Clock In ──────────────────────────────────────────────────────────────────
app.post('/api/attendance/clock-in', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const open = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    if (open) return res.status(400).json({ error: 'Already clocked in' });
 
    const session = await Attendance.create({
      user_id:      req.user.id,
      clock_in:     new Date(),
      clock_in_lat: lat,
      clock_in_lng: lng,
    });
 
    // Save clock-in point as the first location ping
    await Location.create({
      user_id:    req.user.id,
      session_id: session._id,
      lat,
      lng,
      accuracy:    req.body.accuracy || null,
      recorded_at: new Date(),
    });
 
    res.json({ session_id: session._id, clocked_in: session.clock_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
// ── Clock Out ─────────────────────────────────────────────────────────────────
app.post('/api/attendance/clock-out', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    if (!session) return res.status(400).json({ error: 'Not clocked in' });

    const now             = new Date();
    session.clock_out     = now;
    session.clock_out_lat = lat || null;
    session.clock_out_lng = lng || null;
    session.total_minutes = Math.round((now - session.clock_in) / 60000);
    await session.save();

    // STEP 1: Save final clock-out ping
    if (lat && lng) {
      await Location.create({
        user_id:     req.user.id,
        session_id:  session._id,
        lat, lng,
        accuracy:    null,
        recorded_at: now,
      });
    }

    // STEP 2: Count pings BEFORE building — log so you can debug
    const pingCount = await Location.countDocuments({ session_id: session._id });
    console.log(`📍 Pings found for session ${session._id}: ${pingCount}`);

    // STEP 3: Build and save GeoJSON — WAIT for it fully
    const user = await User.findById(req.user.id).lean();
    let routeSaved = false;
    try {
      const geojson = await buildAndSaveGeoJSON(session.toObject(), user);
      routeSaved = geojson !== null;
      console.log(`✅ Route saved: ${routeSaved}, coords: ${geojson?.features?.[0]?.geometry?.coordinates?.length ?? 0}`);
    } catch (err) {
      console.error('❌ GeoJSON save error:', err.message);
    }

    // STEP 4: Only delete pings after route is confirmed saved
    await Location.deleteMany({ session_id: session._id }); // ← delete by session, not user
    console.log(`🗑️ Pings deleted for session ${session._id}`);

    res.json({ session, route_saved: routeSaved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ── Save GPS ping ─────────────────────────────────────────────────────────────
app.post('/api/location', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy, session_id } = req.body;
 
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
 
    // Use session_id sent by app — avoids extra DB query every 15 seconds
    let resolvedSessionId = session_id || null;
 
    // Fallback: look up open session only if app didn't send one
    if (!resolvedSessionId) {
      const session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
      resolvedSessionId = session?._id || null;
    }
 
    await Location.create({
      user_id:     req.user.id,
      session_id:  resolvedSessionId,
      lat,
      lng,
      accuracy:    accuracy ?? null,
      recorded_at: new Date(),
    });
 
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ── GPS Ping (includes speed + heading for real-world movement feel) ────────
// AFTER — trusts session_id from app, falls back to DB lookup only if missing
app.post('/api/location', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy, session_id } = req.body;

    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    let resolvedSessionId = session_id || null;
    if (!resolvedSessionId) {
      const session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
      resolvedSessionId = session?._id || null;
    }

    await Location.create({
      user_id:     req.user.id,
      session_id:  resolvedSessionId,
      lat, lng,
      accuracy:    accuracy ?? null,
      recorded_at: new Date(),
    });

    // ← Add this so you can see pings arriving in server logs
    console.log(`📌 Ping saved — user: ${req.user.id}, session: ${resolvedSessionId}, lat: ${lat}, lng: ${lng}`);

    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── My Attendance History ──────────────────────────────────────────────────
app.get('/api/attendance/me', auth, async (req, res) => {
  try {
    const rows = await Attendance.find({ user_id: req.user.id })
      .sort({ clock_in: -1 }).limit(30).lean();
    const user = await User.findById(req.user.id).lean();
    res.json(rows.map(r => ({ ...r, name: user?.name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin ──────────────────────────────────────────────────────────────────

// Live locations — only users who are currently clocked in appear here
// because location data is wiped on clock-out
app.get('/api/admin/live-locations', auth, admin, async (req, res) => {
  try {
    const locs = await Location.aggregate([
      { $sort: { recorded_at: -1 } },
      { $group: {
          _id:         '$user_id',
          lat:         { $first: '$lat' },
          lng:         { $first: '$lng' },
          accuracy:    { $first: '$accuracy' },
          speed:       { $first: '$speed' },
          heading:     { $first: '$heading' },
          recorded_at: { $first: '$recorded_at' },
          session_id:  { $first: '$session_id' },
      }},
    ]);

    const userIds  = locs.map(l => l._id);a
    const users    = await User.find({ _id: { $in: userIds } }).lean();
    const uMap     = Object.fromEntries(users.map(u => [u._id.toString(), u.name]));

    const sessionIds = locs.filter(l => l.session_id).map(l => l.session_id);
    const sessions   = await Attendance.find({ _id: { $in: sessionIds } }).lean();
    const sMap       = Object.fromEntries(sessions.map(s => [s._id.toString(), s]));

    res.json(locs.map(l => ({
      user_id:      l._id,
      name:         uMap[l._id.toString()] || 'Unknown',
      lat:          l.lat,
      lng:          l.lng,
      accuracy:     l.accuracy,
      speed:        l.speed,
      heading:      l.heading,
      recorded_at:  l.recorded_at,
      session_id:   l.session_id,
      clock_in:     l.session_id ? sMap[l.session_id.toString()]?.clock_in     : null,
      clock_in_lat: l.session_id ? sMap[l.session_id.toString()]?.clock_in_lat : null,
      clock_in_lng: l.session_id ? sMap[l.session_id.toString()]?.clock_in_lng : null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All attendance — supports ?date=YYYY-MM-DD and ?user_id=xxx filtering
app.get('/api/admin/attendance', auth, admin, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    const filter = {};
    if (user_id) filter.user_id = user_id;
    if (date) {
      const start = new Date(date);
      const end   = new Date(date); end.setDate(end.getDate() + 1);
      filter.clock_in = { $gte: start, $lt: end };
    }
    const rows  = await Attendance.find(filter).sort({ clock_in: -1 }).limit(500).lean();
    const uids  = [...new Set(rows.map(r => r.user_id.toString()))];
    const users = await User.find({ _id: { $in: uids } }).lean();
    const uMap  = Object.fromEntries(users.map(u => [u._id.toString(), u]));
    res.json(rows.map(r => ({
      ...r,
      name:  uMap[r.user_id.toString()]?.name,
      email: uMap[r.user_id.toString()]?.email,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All users (no passwords)
app.get('/api/admin/users', auth, admin, async (req, res) => {
  try {
    const users = await User.find({}, '-password_hash').sort({ name: 1 }).lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Location trail for a session (only active sessions have data now)
app.get('/api/admin/location-trail/:session_id', auth, admin, async (req, res) => {
  try {
    const trail = await Location.find({ session_id: req.params.session_id })
      .sort({ recorded_at: 1 }).lean();
    res.json(trail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Location trail for a user (today's pings)
app.get('/api/admin/location-trail/user/:user_id', auth, admin, async (req, res) => {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const trail = await Location.find({
      user_id:     req.params.user_id,
      recorded_at: { $gte: start },
    }).sort({ recorded_at: 1 }).lean();
    res.json(trail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// GET /api/admin/locations/grouped
// One document per session with all coordinates as an array
app.get('/api/admin/locations/grouped', auth, admin, async (req, res) => {
  try {
    const grouped = await Location.aggregate([
      // Sort pings by time BEFORE grouping so coordinates are in order
      { $sort: { recorded_at: 1 } },
      {
        $group: {
          _id:        '$session_id',
          user_id:    { $first: '$user_id' },
          ping_count: { $sum: 1 },
          first_ping: { $first: '$recorded_at' },
          last_ping:  { $last:  '$recorded_at' },
          coordinates: {
            $push: {
              lat:         '$lat',
              lng:         '$lng',
              recorded_at: '$recorded_at',
            },
          },
        },
      },
      // Most recent session first
      { $sort: { first_ping: -1 } },
      // Clean output — rename _id to session_id
      {
        $project: {
          _id:         0,
          session_id:  '$_id',
          user_id:     1,
          ping_count:  1,
          first_ping:  1,
          last_ping:   1,
          coordinates: 1,
        },
      },
    ]);

    res.json(grouped);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
