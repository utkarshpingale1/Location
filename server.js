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
mongoose.connect(process.env.MONGO_URI, { dbName: 'attendance_db' })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ─── Schemas & Models ──────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password_hash: { type: String, required: true },
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
  recorded_at: { type: Date, default: Date.now },
});

const routeGeoJSONSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',       required: true },
  session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true },
  geojson:    { type: mongoose.Schema.Types.Mixed,    required: true },
  metadata: {
    ping_count:    { type: Number, default: 0 },
    point_count:   { type: Number, default: 0 },
    total_minutes: { type: Number, default: null },
    clock_in:      { type: Date,   default: null },
    clock_out:     { type: Date,   default: null },
  },
  saved_at: { type: Date, default: Date.now },
});

attendanceSchema.index({ user_id: 1, clock_in: -1 });
locationSchema.index({ user_id: 1, recorded_at: -1 });
locationSchema.index({ session_id: 1, recorded_at: 1 }); // ✅ FIX: index for ping lookups
routeGeoJSONSchema.index({ session_id: 1 }, { unique: true });
routeGeoJSONSchema.index({ user_id: 1, saved_at: -1 });

const User         = mongoose.model('User',         userSchema);
const Attendance   = mongoose.model('Attendance',   attendanceSchema);
const Location     = mongoose.model('Location',     locationSchema);
const RouteGeoJSON = mongoose.model('RouteGeoJSON', routeGeoJSONSchema);

// ─── Seed default admin (once on startup) ─────────────────────────────────
async function seedAdmin() {
  const exists = await User.findOne({ email: 'admin@company.com' });
  if (!exists) {
    const hash = await bcrypt.hash('Admin@1234', 10);
    await User.create({ name: 'Admin', email: 'admin@company.com', password_hash: hash, role: 'admin' });
    console.log('🌱 Default admin → admin@company.com / Admin@1234');
  }
}
mongoose.connection.once('open', seedAdmin);

// ─── Auth Middleware ────────────────────────────────────────────────────────
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

// ─── buildAndSaveGeoJSON helper ────────────────────────────────────────────
async function buildAndSaveGeoJSON(session, user) {
  // ✅ FIX: Cast session._id to ObjectId for reliable ping lookup
  const sessionObjId = new mongoose.Types.ObjectId(session._id.toString());

  const pings = await Location.find({ session_id: sessionObjId })
    .sort({ recorded_at: 1 }).lean();

  console.log(`📍 Building GeoJSON for session ${session._id} — ${pings.length} pings found`);

  const coords = [];
  if (session.clock_in_lat  != null && session.clock_in_lng  != null)
    coords.push([session.clock_in_lng,  session.clock_in_lat]);
  pings.forEach(p => coords.push([p.lng, p.lat]));
  if (session.clock_out_lat != null && session.clock_out_lng != null)
    coords.push([session.clock_out_lng, session.clock_out_lat]);

  console.log(`📐 Total coords: ${coords.length}`);

  if (coords.length < 2) {
    console.warn(`⚠️ Not enough coords to build route (need ≥ 2, got ${coords.length})`);
    return null;
  }

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
    { session_id: sessionObjId },
    {
      user_id:    session.user_id,
      session_id: sessionObjId,
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

  console.log(`✅ GeoJSON saved for session ${session._id}`);
  return geojson;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Missing fields' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email format' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password_hash: hash, role: 'employee' });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user._id.toString(), name: user.name, role: user.role },
      process.env.JWT_SECRET || 'supersecret',
      { expiresIn: '12h' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clock In
app.post('/api/attendance/clock-in', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat == null || lng == null || isNaN(lat) || isNaN(lng))
      return res.status(400).json({ error: 'Valid lat and lng are required' });

    // ✅ FIX: Cast user_id to ObjectId for reliable lookup
    const userObjId = new mongoose.Types.ObjectId(req.user.id);
    const open = await Attendance.findOne({ user_id: userObjId, clock_out: null });
    if (open) return res.status(400).json({ error: 'Already clocked in' });

    const session = await Attendance.create({
      user_id:      userObjId,
      clock_in:     new Date(),
      clock_in_lat: lat,
      clock_in_lng: lng,
    });

    console.log(`✅ Clocked in: user=${req.user.id} session=${session._id}`);
    // ✅ FIX: Return both session_id AND _id so Flutter can store it
    res.json({ session_id: session._id, _id: session._id, clocked_in: session.clock_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clock Out
app.post('/api/attendance/clock-out', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    // ✅ FIX: Cast user_id to ObjectId
    const userObjId = new mongoose.Types.ObjectId(req.user.id);
    const session = await Attendance.findOne({ user_id: userObjId, clock_out: null });
    if (!session) return res.status(400).json({ error: 'Not clocked in' });

    const now = new Date();
    session.clock_out     = now;
    // ✅ FIX: Accept null from Flutter instead of 0,0 fallback
    session.clock_out_lat = (lat != null && !isNaN(lat) && lat !== 0) ? lat : null;
    session.clock_out_lng = (lng != null && !isNaN(lng) && lng !== 0) ? lng : null;
    session.total_minutes = Math.round((now - session.clock_in) / 60000);
    await session.save();

    console.log(`✅ Clocked out: user=${req.user.id} session=${session._id} minutes=${session.total_minutes}`);

    const user = await User.findById(req.user.id).lean();
    buildAndSaveGeoJSON(session.toObject(), user).catch(err =>
      console.error('⚠️  GeoJSON auto-save failed:', err.message)
    );

    res.json({ session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ FIX: Save GPS ping — now accepts session_id from Flutter directly
app.post('/api/location', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy, session_id } = req.body;

    if (lat == null || lng == null || isNaN(lat) || isNaN(lng))
      return res.status(400).json({ error: 'Valid lat and lng are required' });

    // ✅ FIX: Cast user_id to ObjectId
    const userObjId = new mongoose.Types.ObjectId(req.user.id);

    // ✅ FIX: Use session_id from Flutter body first, fallback to DB lookup
    let sessionObjId = null;

    if (session_id && mongoose.Types.ObjectId.isValid(session_id)) {
      // Flutter sent session_id directly — most reliable
      sessionObjId = new mongoose.Types.ObjectId(session_id);
    } else {
      // Fallback: look up open session in DB
      const session = await Attendance.findOne({ user_id: userObjId, clock_out: null });
      if (session) {
        sessionObjId = session._id;
      } else {
        console.warn(`⚠️ No open session found for user ${req.user.id} during ping`);
      }
    }

    await Location.create({
      user_id:    userObjId,
      session_id: sessionObjId,
      lat,
      lng,
      accuracy,
    });

    console.log(`📍 Ping saved: user=${req.user.id} session=${sessionObjId} lat=${lat} lng=${lng}`);
    res.json({ saved: true, session_id: sessionObjId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Employee — save own shift route (no admin required)
// ✅ NEW: Employee-accessible route save endpoint
app.post('/api/attendance/:sessionId/save-route', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.sessionId))
      return res.status(400).json({ error: 'Invalid session ID' });

    const session = await Attendance.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // ✅ Employee can only save their own session
    if (session.user_id.toString() !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const user    = await User.findById(session.user_id).lean();
    const geojson = await buildAndSaveGeoJSON(session, user);

    if (!geojson)
      return res.status(400).json({ error: 'Not enough location data (need ≥ 2 coordinates)' });

    res.json({ saved: true, session_id: session._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// My attendance history
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

// Employee — fetch own saved GeoJSON routes
app.get('/api/routes/me', auth, async (req, res) => {
  try {
    const routes = await RouteGeoJSON.find({ user_id: req.user.id })
      .sort({ saved_at: -1 }).limit(30).lean();
    res.json(routes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// Live locations (latest ping per user)
app.get('/api/admin/live-locations', auth, admin, async (req, res) => {
  try {
    const locs = await Location.aggregate([
      { $sort: { recorded_at: -1 } },
      { $group: {
          _id:         '$user_id',
          lat:         { $first: '$lat' },
          lng:         { $first: '$lng' },
          accuracy:    { $first: '$accuracy' },
          recorded_at: { $first: '$recorded_at' },
          session_id:  { $first: '$session_id' },
      }},
    ]);

    const userIds = locs.map(l => l._id);
    const users   = await User.find({ _id: { $in: userIds } }).lean();
    const uMap    = Object.fromEntries(users.map(u => [u._id.toString(), u.name]));

    const sessionIds = locs.filter(l => l.session_id).map(l => l.session_id);
    const sessions   = await Attendance.find({ _id: { $in: sessionIds } }).lean();
    const sMap       = Object.fromEntries(sessions.map(s => [s._id.toString(), s]));

    res.json(locs.map(l => ({
      user_id:     l._id,
      name:        uMap[l._id.toString()] || 'Unknown',
      lat:         l.lat,
      lng:         l.lng,
      accuracy:    l.accuracy,
      recorded_at: l.recorded_at,
      session_id:  l.session_id,
      clock_in:    l.session_id ? sMap[l.session_id.toString()]?.clock_in : null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All attendance (with date & user filters)
app.get('/api/admin/attendance', auth, admin, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    const filter = {};
    if (user_id) filter.user_id = user_id;
    if (date) {
      const start = new Date(date);
      if (isNaN(start.getTime()))
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      const end = new Date(date); end.setDate(end.getDate() + 1);
      filter.clock_in = { $gte: start, $lt: end };
    }

    const rows  = await Attendance.find(filter).sort({ clock_in: -1 }).limit(200).lean();
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

// Location trail for a session
app.get('/api/admin/location-trail/:session_id', auth, admin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.session_id))
      return res.status(400).json({ error: 'Invalid session ID' });

    const trail = await Location.find({ session_id: req.params.session_id })
      .sort({ recorded_at: 1 }).lean();
    res.json(trail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin — query all stored GeoJSON routes
app.get('/api/admin/routes', auth, admin, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    const filter = {};
    if (user_id) filter.user_id = user_id;
    if (date) {
      const start = new Date(date);
      if (isNaN(start.getTime()))
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      const end = new Date(date); end.setDate(end.getDate() + 1);
      filter['metadata.clock_in'] = { $gte: start, $lt: end };
    }
    const routes = await RouteGeoJSON.find(filter)
      .sort({ saved_at: -1 }).limit(100).lean();
    res.json(routes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin — manually trigger GeoJSON save for any session
app.post('/api/admin/routes/save/:sessionId', auth, admin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.sessionId))
      return res.status(400).json({ error: 'Invalid session ID' });

    const session = await Attendance.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const user    = await User.findById(session.user_id).lean();
    const geojson = await buildAndSaveGeoJSON(session, user);

    if (!geojson)
      return res.status(400).json({ error: 'Not enough location data to build a route (need ≥ 2 coordinates)' });

    res.json({ saved: true, session_id: session._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single shift route: GET /api/attendance/:id/geojson
app.get('/api/attendance/:id/geojson', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ error: 'Invalid shift ID' });

    const session = await Attendance.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Shift not found' });

    if (req.user.role !== 'admin' && session.user_id.toString() !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const user    = await User.findById(session.user_id).lean();
    const geojson = await buildAndSaveGeoJSON(session, user);

    if (!geojson)
      return res.status(400).json({ error: 'Not enough location data to build a route' });

    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shift_${session._id}_route.geojson"`
    );
    res.json(geojson);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: All shifts for an employee on a given date
app.get('/api/admin/employee/:empId/geojson', auth, admin, async (req, res) => {
  try {
    const { empId } = req.params;
    const { date }  = req.query;

    if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

    if (!mongoose.Types.ObjectId.isValid(empId))
      return res.status(400).json({ error: 'Invalid employee ID' });

    const start = new Date(date);
    if (isNaN(start.getTime()))
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });

    const end = new Date(date); end.setDate(end.getDate() + 1);

    const shifts = await Attendance.find({
      user_id:  empId,
      clock_in: { $gte: start, $lt: end },
    }).sort({ clock_in: 1 }).lean();

    const user     = await User.findById(empId).lean();
    const features = [];

    for (const s of shifts) {
      const pings = await Location.find({ session_id: s._id })
        .sort({ recorded_at: 1 }).lean();

      const coords = [];
      if (s.clock_in_lat  != null && s.clock_in_lng  != null) coords.push([s.clock_in_lng,  s.clock_in_lat]);
      pings.forEach(p => coords.push([p.lng, p.lat]));
      if (s.clock_out_lat != null && s.clock_out_lng != null) coords.push([s.clock_out_lng, s.clock_out_lat]);

      if (coords.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties: {
            shift_id:      s._id,
            clock_in:      s.clock_in,
            clock_out:     s.clock_out    ?? null,
            total_minutes: s.total_minutes ?? null,
            ping_count:    pings.length,
          },
        });
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[0] },
          properties: { label: "Clock In",  time: s.clock_in,              marker: "green" },
        });
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[coords.length - 1] },
          properties: { label: "Clock Out", time: s.clock_out ?? "Active", marker: "red" },
        });
      }
    }

    if (features.length === 0)
      return res.status(404).json({ error: 'No location data found for this employee on that date' });

    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${user?.name ?? empId}_${date}_routes.geojson"`
    );
    res.json({ type: "FeatureCollection", features });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
