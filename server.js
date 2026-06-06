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

// ─── Schemas ──────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password:      { type: String, default: null },
  password_hash: { type: String, default: null },
  role:          { type: String, enum: ['admin', 'employee'], default: 'employee' },
}, { timestamps: true });

// ─── Attendance Schema ─────────────────────────────────────────────────────
// location_trail is an array that grows every 15 seconds.
// Each entry = { lat, lng, accuracy, speed, heading, recorded_at }
// This means all location data lives INSIDE the attendance document —
// no separate Location collection needed.
//
// MongoDB document will look like:
// {
//   user_id: ObjectId,
//   clock_in: Date,
//   clock_out: Date,
//   clock_in_lat: Number,
//   clock_in_lng: Number,
//   location_trail: [
//     { lat: 19.07, lng: 72.87, recorded_at: Date },   ← clock-in point
//     { lat: 19.08, lng: 72.88, recorded_at: Date },   ← 15s ping
//     { lat: 19.09, lng: 72.89, recorded_at: Date },   ← 30s ping
//     ...
//   ]
// }

const locationPingSchema = new mongoose.Schema({
  lat:         { type: Number, required: true },
  lng:         { type: Number, required: true },
  accuracy:    { type: Number, default: null },
  speed:       { type: Number, default: null },
  heading:     { type: Number, default: null },
  recorded_at: { type: Date,   default: Date.now },
}, { _id: false }); // no separate _id per ping — they live inside the parent doc

const attendanceSchema = new mongoose.Schema({
  user_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clock_in:       { type: Date,   required: true },
  clock_out:      { type: Date,   default: null },
  clock_in_lat:   { type: Number, default: null },
  clock_in_lng:   { type: Number, default: null },
  clock_out_lat:  { type: Number, default: null },
  clock_out_lng:  { type: Number, default: null },
  total_minutes:  { type: Number, default: null },
  notes:          { type: String, default: null },

  // ✅ All location pings stored here — grows every 15 seconds
  location_trail: { type: [locationPingSchema], default: [] },

}, { timestamps: true });

attendanceSchema.index({ user_id: 1, clock_in: -1 });

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

// ─── Models ────────────────────────────────────────────────────────────────
const User         = mongoose.model('User',         userSchema);
const Attendance   = mongoose.model('Attendance',   attendanceSchema);
const RouteGeoJSON = mongoose.model('RouteGeoJSON', routeGeoJSONSchema);

// ─── Build & Save GeoJSON from location_trail array ───────────────────────
async function buildAndSaveGeoJSON(session, user) {
  const trail = session.location_trail || [];

  // Convert trail to [lng, lat] pairs (GeoJSON uses lng first)
  const coords = trail.map(p => [p.lng, p.lat]);

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
          ping_count:     trail.length,
          point_count:    coords.length,
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: coords[0] },
        properties: { label: "Clock In",  time: session.clock_in,          marker: "green" },
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
        ping_count:    trail.length,
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

// ══════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════

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

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    let ok = false;
    if (user.password && typeof user.password === 'string') {
      ok = password === user.password;
    } else if (user.password_hash && typeof user.password_hash === 'string') {
      ok = await bcrypt.compare(password, user.password_hash);
    }
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

// ══════════════════════════════════════════════════════════════════════════
//  CLOCK IN / OUT
// ══════════════════════════════════════════════════════════════════════════

// ── Clock In ───────────────────────────────────────────────────────────────
// Body: { lat, lng, accuracy }
// Creates the attendance document with the first ping already in location_trail
app.post('/api/attendance/clock-in', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;

    const open = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    if (open) return res.status(400).json({ error: 'Already clocked in', session_id: open._id });

    const firstPing = (lat != null && lng != null)
      ? [{ lat, lng, accuracy: accuracy ?? null, recorded_at: new Date() }]
      : [];

    const session = await Attendance.create({
      user_id:        req.user.id,
      clock_in:       new Date(),
      clock_in_lat:   lat ?? null,
      clock_in_lng:   lng ?? null,
      location_trail: firstPing,   // ← first ping already inside the document
    });

    console.log(`🟢 Clock-in  user:${req.user.id}  session:${session._id}  lat:${lat}  lng:${lng}`);
    res.json({ session_id: session._id, clocked_in: session.clock_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clock Out ──────────────────────────────────────────────────────────────
// Body: { lat, lng }
app.post('/api/attendance/clock-out', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    const session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    if (!session) return res.status(400).json({ error: 'Not clocked in' });

    const now = new Date();

    // Push final location into the trail
    if (lat != null && lng != null) {
      session.location_trail.push({ lat, lng, accuracy: null, recorded_at: now });
    }

    session.clock_out     = now;
    session.clock_out_lat = lat ?? null;
    session.clock_out_lng = lng ?? null;
    session.total_minutes = Math.round((now - session.clock_in) / 60000);
    await session.save();

    const pingCount = session.location_trail.length;
    console.log(`📍 Total pings in trail: ${pingCount}`);

    // Build and save GeoJSON route
    const user = await User.findById(req.user.id).lean();
    let routeSaved = false;
    try {
      const geojson = await buildAndSaveGeoJSON(session.toObject(), user);
      routeSaved = geojson !== null;
    } catch (err) {
      console.error('❌ GeoJSON save error:', err.message);
    }

    console.log(`🔴 Clock-out  user:${req.user.id}  session:${session._id}  minutes:${session.total_minutes}`);
    res.json({ session_id: session._id, total_pings: pingCount, route_saved: routeSaved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  LOCATION PING — app calls this every 15 seconds while clocked in
// ══════════════════════════════════════════════════════════════════════════
//
//  POST /api/location
//  Headers: Authorization: Bearer <token>
//  Body:    { lat, lng, accuracy, speed, heading, session_id }
//
//  Each call pushes ONE new entry into attendance.location_trail —
//  so the document grows in place, no separate collection touched.
//
//  After 10 pings the attendance document in MongoDB looks like:
//  {
//    _id: ObjectId,
//    user_id: ObjectId,
//    clock_in: ISODate,
//    location_trail: [
//      { lat: 19.0760, lng: 72.8777, recorded_at: ISODate },  ← clock-in
//      { lat: 19.0761, lng: 72.8778, recorded_at: ISODate },  ← 15s
//      { lat: 19.0762, lng: 72.8779, recorded_at: ISODate },  ← 30s
//      { lat: 19.0765, lng: 72.8780, recorded_at: ISODate },  ← 45s
//      ...
//    ]
//  }

app.post('/api/location', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy, speed, heading, session_id } = req.body;

    if (lat == null || lng == null)
      return res.status(400).json({ error: 'lat and lng are required' });

    // Find the active session — prefer session_id from app for speed
    let session;
    if (session_id) {
      session = await Attendance.findOne({ _id: session_id, user_id: req.user.id, clock_out: null });
    }
    if (!session) {
      session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    }
    if (!session) {
      return res.status(400).json({ error: 'No active session — please clock in first' });
    }

    // ✅ Push the new ping into the embedded array inside the attendance document
    await Attendance.updateOne(
      { _id: session._id },
      {
        $push: {
          location_trail: {
            lat,
            lng,
            accuracy: accuracy ?? null,
            speed:    speed    ?? null,
            heading:  heading  ?? null,
            recorded_at: new Date(),
          },
        },
      }
    );

    const pingNumber = (session.location_trail?.length ?? 0) + 1;
    console.log(`📌 Ping #${pingNumber}  user:${req.user.id}  session:${session._id}  lat:${lat}  lng:${lng}`);
    res.json({ saved: true, session_id: session._id, ping_number: pingNumber });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── My attendance history ──────────────────────────────────────────────────
app.get('/api/attendance/me', auth, async (req, res) => {
  try {
    const rows = await Attendance.find({ user_id: req.user.id })
      .sort({ clock_in: -1 }).limit(30).lean();
    const user = await User.findById(req.user.id).lean();
    res.json(rows.map(r => ({
      ...r,
      name:       user?.name,
      ping_count: r.location_trail?.length ?? 0,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── View full trail for one session (employee's own) ──────────────────────
app.get('/api/attendance/:id/trail', auth, async (req, res) => {
  try {
    const session = await Attendance.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && session.user_id.toString() !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    res.json({
      session_id:     session._id,
      clock_in:       session.clock_in,
      clock_out:      session.clock_out,
      total_minutes:  session.total_minutes,
      ping_count:     session.location_trail?.length ?? 0,
      location_trail: session.location_trail,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GeoJSON for a single shift ─────────────────────────────────────────────
app.get('/api/attendance/:id/geojson', auth, async (req, res) => {
  try {
    const session = await Attendance.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Shift not found' });
    if (req.user.role !== 'admin' && session.user_id.toString() !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const saved = await RouteGeoJSON.findOne({ session_id: session._id }).lean();
    if (saved) {
      res.setHeader('Content-Type', 'application/geo+json');
      return res.json(saved.geojson);
    }

    const user    = await User.findById(session.user_id).lean();
    const geojson = await buildAndSaveGeoJSON(session, user);
    if (!geojson)
      return res.status(400).json({ error: 'Not enough location data' });

    res.setHeader('Content-Type', 'application/geo+json');
    res.json(geojson);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manually save route for own shift ─────────────────────────────────────
app.post('/api/attendance/:id/save-route', auth, async (req, res) => {
  try {
    const session = await Attendance.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role !== 'admin' && session.user_id.toString() !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    const user    = await User.findById(session.user_id).lean();
    const geojson = await buildAndSaveGeoJSON(session, user);
    if (!geojson) return res.status(400).json({ error: 'Not enough location data' });
    res.json({ saved: true, session_id: session._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', auth, admin, async (req, res) => {
  try {
    const users = await User.find({}, '-password_hash').sort({ name: 1 }).lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── All attendance (with ping counts) ─────────────────────────────────────
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
      name:       uMap[r.user_id.toString()]?.name,
      email:      uMap[r.user_id.toString()]?.email,
      ping_count: r.location_trail?.length ?? 0,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Live locations — latest ping from each active session ──────────────────
app.get('/api/admin/live-locations', auth, admin, async (req, res) => {
  try {
    // Find all sessions currently clocked in
    const activeSessions = await Attendance.find({ clock_out: null }).lean();

    const userIds = activeSessions.map(s => s.user_id);
    const users   = await User.find({ _id: { $in: userIds } }).lean();
    const uMap    = Object.fromEntries(users.map(u => [u._id.toString(), u]));

    const result = activeSessions.map(s => {
      const trail  = s.location_trail ?? [];
      const latest = trail[trail.length - 1] ?? null;
      const user   = uMap[s.user_id.toString()];
      return {
        user_id:     s.user_id,
        name:        user?.name  ?? 'Unknown',
        email:       user?.email ?? null,
        session_id:  s._id,
        clock_in:    s.clock_in,
        ping_count:  trail.length,
        // Latest known position
        lat:         latest?.lat         ?? null,
        lng:         latest?.lng         ?? null,
        accuracy:    latest?.accuracy    ?? null,
        speed:       latest?.speed       ?? null,
        heading:     latest?.heading     ?? null,
        recorded_at: latest?.recorded_at ?? null,
      };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Full trail for any session ─────────────────────────────────────────────
app.get('/api/admin/location-trail/:session_id', auth, admin, async (req, res) => {
  try {
    const session = await Attendance.findById(req.params.session_id).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      session_id:     session._id,
      user_id:        session.user_id,
      clock_in:       session.clock_in,
      clock_out:      session.clock_out,
      total_minutes:  session.total_minutes,
      ping_count:     session.location_trail?.length ?? 0,
      location_trail: session.location_trail,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── All sessions for a user (with trails) ─────────────────────────────────
app.get('/api/admin/location-trail/user/:user_id', auth, admin, async (req, res) => {
  try {
    const { date } = req.query;
    const filter = { user_id: req.params.user_id };
    if (date) {
      const start = new Date(date);
      const end   = new Date(date); end.setDate(end.getDate() + 1);
      filter.clock_in = { $gte: start, $lt: end };
    }
    const sessions = await Attendance.find(filter).sort({ clock_in: -1 }).lean();
    res.json(sessions.map(s => ({
      session_id:     s._id,
      clock_in:       s.clock_in,
      clock_out:      s.clock_out,
      total_minutes:  s.total_minutes,
      ping_count:     s.location_trail?.length ?? 0,
      location_trail: s.location_trail,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── All saved GeoJSON routes ───────────────────────────────────────────────
app.get('/api/admin/routes', auth, admin, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    const filter = {};
    if (user_id) filter.user_id = user_id;
    if (date) {
      const start = new Date(date);
      const end   = new Date(date); end.setDate(end.getDate() + 1);
      filter['metadata.clock_in'] = { $gte: start, $lt: end };
    }
    const routes = await RouteGeoJSON.find(filter).sort({ saved_at: -1 }).limit(100).lean();
    res.json(routes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manually backfill GeoJSON for a session ────────────────────────────────
app.post('/api/admin/routes/save/:sessionId', auth, admin, async (req, res) => {
  try {
    const session = await Attendance.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const user    = await User.findById(session.user_id).lean();
    const geojson = await buildAndSaveGeoJSON(session, user);
    if (!geojson) return res.status(400).json({ error: 'Not enough location data' });
    res.json({ saved: true, session_id: session._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Employee routes by date (GeoJSON download) ─────────────────────────────
app.get('/api/admin/employee/:empId/geojson', auth, admin, async (req, res) => {
  try {
    const { empId } = req.params;
    const { date }  = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
    const start = new Date(date);
    const end   = new Date(date); end.setDate(end.getDate() + 1);
    const shifts = await Attendance.find({
      user_id:  empId,
      clock_in: { $gte: start, $lt: end },
    }).sort({ clock_in: 1 }).lean();
    const user     = await User.findById(empId).lean();
    const features = [];
    for (const s of shifts) {
      const saved = await RouteGeoJSON.findOne({ session_id: s._id }).lean();
      if (saved) features.push(...saved.geojson.features);
    }
    if (features.length === 0)
      return res.status(404).json({ error: 'No route data found for this employee on that date' });
    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition',
      `attachment; filename="${user?.name ?? empId}_${date}_routes.geojson"`);
    res.json({ type: "FeatureCollection", features });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
