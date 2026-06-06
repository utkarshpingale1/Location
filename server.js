"""
migrate_mongo_to_postgres.py
────────────────────────────
Reads every attendance session from MongoDB Atlas,
flattens the embedded location_trail array,
and inserts each ping as a row into PostgreSQL.

PostgreSQL table created:
┌─────────────────┬───────────────────────────────────────────────────────┐
│ column          │ description                                           │
├─────────────────┼───────────────────────────────────────────────────────┤
│ id              │ auto-increment primary key                            │
│ session_id      │ MongoDB attendance _id (text)                         │
│ user_id         │ MongoDB user _id (text)                               │
│ user_name       │ employee name                                         │
│ user_email      │ employee email                                        │
│ clock_in        │ session clock-in timestamp                            │
│ clock_out       │ session clock-out timestamp (null if active)          │
│ total_minutes   │ shift duration                                        │
│ lat             │ latitude of this ping                                 │
│ lng             │ longitude of this ping                                │
│ accuracy        │ GPS accuracy in metres                                │
│ speed           │ speed at ping time                                    │
│ heading         │ direction at ping time                                │
│ recorded_at     │ exact timestamp of this ping                          │
│ ping_index      │ position of this ping in the trail (0 = first)       │
└─────────────────┴───────────────────────────────────────────────────────┘

Usage:
    pip install pymongo psycopg2-binary python-dotenv
    python migrate_mongo_to_postgres.py

    # or with env vars inline:
    MONGO_URI="mongodb+srv://..." DATABASE_URL="postgresql://..." python migrate_mongo_to_postgres.py
"""

import os
import sys
from datetime import timezone

from dotenv import load_dotenv
load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
MONGO_URI    = os.getenv("MONGO_URI")           # your Atlas connection string
MONGO_DB     = os.getenv("MONGO_DB", "login_user")
MONGO_COLLECTION = "attendances"                # mongoose pluralises the model name

POSTGRES_URI = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@192.168.1.156:5432/Indian_Railway"
)

PG_TABLE = "employee_location_trail"           # table that will be created in Postgres

# ── Validate ──────────────────────────────────────────────────────────────────
if not MONGO_URI:
    print("❌  MONGO_URI is not set.")
    print("    Add it to your .env file or export it before running.")
    sys.exit(1)

# ── Imports ───────────────────────────────────────────────────────────────────
try:
    from pymongo import MongoClient
except ImportError:
    print("❌  pymongo not installed. Run:  pip install pymongo")
    sys.exit(1)

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("❌  psycopg2 not installed. Run:  pip install psycopg2-binary")
    sys.exit(1)


# ── Helpers ───────────────────────────────────────────────────────────────────
def to_utc(dt):
    """Make a datetime timezone-aware (UTC) if it isn't already."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# ── Connect to MongoDB Atlas ──────────────────────────────────────────────────
print("🔗  Connecting to MongoDB Atlas …")
mongo_client = MongoClient(MONGO_URI)
mongo_db     = mongo_client[MONGO_DB]
attendance_col = mongo_db[MONGO_COLLECTION]
users_col      = mongo_db["users"]

# Build a user lookup map  { user_id_str -> { name, email } }
print("👤  Loading users …")
users_map = {}
for u in users_col.find({}, {"name": 1, "email": 1}):
    users_map[str(u["_id"])] = {
        "name":  u.get("name",  ""),
        "email": u.get("email", ""),
    }
print(f"    Found {len(users_map)} users.")


# ── Connect to PostgreSQL ─────────────────────────────────────────────────────
print("🔗  Connecting to PostgreSQL …")
try:
    pg_conn   = psycopg2.connect(POSTGRES_URI)
    pg_cursor = pg_conn.cursor()
    print("    Connected.")
except Exception as e:
    print(f"❌  PostgreSQL connection failed: {e}")
    sys.exit(1)


# ── Create table if not exists ────────────────────────────────────────────────
print(f"🛠️   Creating table '{PG_TABLE}' if it doesn't exist …")
pg_cursor.execute(f"""
CREATE TABLE IF NOT EXISTS {PG_TABLE} (
    id             SERIAL PRIMARY KEY,
    session_id     TEXT        NOT NULL,
    user_id        TEXT        NOT NULL,
    user_name      TEXT,
    user_email     TEXT,
    clock_in       TIMESTAMPTZ,
    clock_out      TIMESTAMPTZ,
    total_minutes  INTEGER,
    lat            DOUBLE PRECISION NOT NULL,
    lng            DOUBLE PRECISION NOT NULL,
    accuracy       DOUBLE PRECISION,
    speed          DOUBLE PRECISION,
    heading        DOUBLE PRECISION,
    recorded_at    TIMESTAMPTZ,
    ping_index     INTEGER,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
""")

# Index for fast queries by session and user
pg_cursor.execute(f"""
CREATE INDEX IF NOT EXISTS idx_{PG_TABLE}_session
    ON {PG_TABLE} (session_id);
""")
pg_cursor.execute(f"""
CREATE INDEX IF NOT EXISTS idx_{PG_TABLE}_user
    ON {PG_TABLE} (user_id);
""")
pg_cursor.execute(f"""
CREATE INDEX IF NOT EXISTS idx_{PG_TABLE}_recorded_at
    ON {PG_TABLE} (recorded_at);
""")
pg_conn.commit()
print("    Table ready.")


# ── Migrate ───────────────────────────────────────────────────────────────────
print("🚚  Starting migration …\n")

total_sessions = 0
total_pings    = 0
skipped        = 0

# Fetch all attendance sessions from MongoDB
for session in attendance_col.find({}):
    total_sessions += 1
    session_id    = str(session["_id"])
    user_id_str   = str(session.get("user_id", ""))
    user_info     = users_map.get(user_id_str, {"name": "", "email": ""})
    user_name     = user_info["name"]
    user_email    = user_info["email"]
    clock_in      = to_utc(session.get("clock_in"))
    clock_out     = to_utc(session.get("clock_out"))
    total_minutes = session.get("total_minutes")
    trail         = session.get("location_trail", [])

    if not trail:
        print(f"  ⚠️  Session {session_id} has no location_trail — skipping.")
        skipped += 1
        continue

    # Build rows — one row per ping in the embedded array
    rows = []
    for idx, ping in enumerate(trail):
        lat         = ping.get("lat")
        lng         = ping.get("lng")
        if lat is None or lng is None:
            continue                        # skip malformed pings
        rows.append((
            session_id,
            user_id_str,
            user_name,
            user_email,
            clock_in,
            clock_out,
            total_minutes,
            lat,
            lng,
            ping.get("accuracy"),
            ping.get("speed"),
            ping.get("heading"),
            to_utc(ping.get("recorded_at")),
            idx,                            # ping_index — position in trail
        ))

    if not rows:
        skipped += 1
        continue

    # Bulk insert all pings for this session in one query
    execute_values(
        pg_cursor,
        f"""
        INSERT INTO {PG_TABLE}
            (session_id, user_id, user_name, user_email,
             clock_in, clock_out, total_minutes,
             lat, lng, accuracy, speed, heading,
             recorded_at, ping_index)
        VALUES %s
        ON CONFLICT DO NOTHING
        """,
        rows,
    )
    pg_conn.commit()
    total_pings += len(rows)

    print(f"  ✅  Session {session_id}  |  user: {user_name or user_id_str}  |  pings: {len(rows)}")

# ── Done ──────────────────────────────────────────────────────────────────────
pg_cursor.close()
pg_conn.close()
mongo_client.close()

print(f"""
────────────────────────────────────────
✅  Migration complete
    Sessions processed : {total_sessions}
    Sessions skipped   : {skipped}
    Total pings saved  : {total_pings}
    PostgreSQL table   : {PG_TABLE}
────────────────────────────────────────

Each row in '{PG_TABLE}' looks like:
  session_id    → MongoDB attendance _id
  user_name     → Sumit Sopan Somwanshi
  clock_in      → 2026-06-06 10:18:36 UTC
  lat / lng     → 56.5017183 / -115.31196
  recorded_at   → exact timestamp of the ping
  ping_index    → 0 = clock-in, 1 = first 15s ping, etc.

To query all pings for a session:
  SELECT * FROM {PG_TABLE}
  WHERE session_id = '<your_session_id>'
  ORDER BY ping_index;

To query all pings for an employee today:
  SELECT * FROM {PG_TABLE}
  WHERE user_name = 'Sumit Sopan Somwanshi'
    AND recorded_at >= CURRENT_DATE
  ORDER BY recorded_at;
""")
