"""SurplusLink backend: a Flask + SQLite REST API that also serves the frontend.

Run:  python app.py   then open http://localhost:5000
"""
import math
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend"))
DB_PATH = os.environ.get("SURPLUSLINK_DB", os.path.join(BASE_DIR, "surpluslink.db"))
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me-before-deploying")
TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7 days
MAX_PICKUP_WINDOW = timedelta(hours=48)  # food-safety guard

ROLES = ("donor", "receiver")
STATUSES = ("available", "claimed", "completed", "expired", "cancelled")
FOOD_TYPES = (
    "Cooked meals",
    "Bakery",
    "Fruits & vegetables",
    "Packaged food",
    "Beverages",
    "Other",
)

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
serializer = URLSafeTimedSerializer(SECRET_KEY)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    org TEXT,
    role TEXT NOT NULL CHECK (role IN ('donor', 'receiver', 'admin')),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    food_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    address TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    pickup_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'claimed', 'completed', 'expired', 'cancelled')),
    claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, pickup_by);
"""

LISTING_SQL = """
SELECT l.*,
       d.name AS donor_name, d.org AS donor_org, d.phone AS donor_phone,
       c.name AS claimer_name, c.phone AS claimer_phone
FROM listings l
JOIN users d ON d.id = l.donor_id
LEFT JOIN users c ON c.id = l.claimed_by
"""


# ---------------------------------------------------------------- helpers
def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value):
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def error(message, code=400):
    return jsonify({"error": message}), code


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    if not db.execute("SELECT 1 FROM users WHERE role = 'admin'").fetchone():
        email = os.environ.get("ADMIN_EMAIL", "admin@surpluslink.local").lower()
        password = os.environ.get("ADMIN_PASSWORD", "admin123")
        db.execute(
            "INSERT INTO users (name, email, role, password_hash, created_at) "
            "VALUES (?, ?, 'admin', ?, ?)",
            ("Admin", email, generate_password_hash(password), iso(utcnow())),
        )
        print(f"Created admin account: {email} / {password}  (change this before deploying)")
    db.commit()
    db.close()


def expire_old(db):
    """Listings nobody claimed before the pickup deadline become 'expired'."""
    db.execute(
        "UPDATE listings SET status = 'expired' WHERE status = 'available' AND pickup_by <= ?",
        (iso(utcnow()),),
    )
    db.commit()


# ------------------------------------------------------------------- auth
def make_token(user_id):
    return serializer.dumps({"uid": user_id})


def current_user():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    try:
        data = serializer.loads(header[7:], max_age=TOKEN_MAX_AGE)
    except BadSignature:
        return None
    return get_db().execute("SELECT * FROM users WHERE id = ?", (data["uid"],)).fetchone()


def require_auth(*roles):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if not user:
                return error("Log in to continue.", 401)
            if roles and user["role"] not in roles:
                return error("Your account type can't do this.", 403)
            g.user = user
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def user_to_dict(u):
    return {k: u[k] for k in ("id", "name", "email", "phone", "org", "role", "created_at")}


# --------------------------------------------------------------- listings
def listing_to_dict(row, viewer=None, lat=None, lng=None):
    keys = (
        "id", "donor_id", "title", "description", "food_type", "quantity", "address",
        "lat", "lng", "pickup_by", "status", "claimed_by", "created_at", "claimed_at",
        "completed_at", "donor_name", "donor_org", "claimer_name",
    )
    d = {k: row[k] for k in keys}
    involved = viewer and (
        viewer["role"] == "admin" or viewer["id"] in (row["donor_id"], row["claimed_by"])
    )
    if involved and row["status"] in ("claimed", "completed"):
        d["donor_phone"] = row["donor_phone"]
        d["claimer_phone"] = row["claimer_phone"]
    if lat is not None and lng is not None:
        d["distance_km"] = round(haversine_km(lat, lng, row["lat"], row["lng"]), 1)
    return d


def fetch_listing(db, listing_id):
    return db.execute(LISTING_SQL + " WHERE l.id = ?", (listing_id,)).fetchone()


def parse_listing(data):
    title = (data.get("title") or "").strip()
    if not title:
        return None, "Add a short title, like 'Veg biryani, 20 plates'."
    try:
        quantity = int(data.get("quantity"))
    except (TypeError, ValueError):
        return None, "Enter how many servings are available."
    if not 1 <= quantity <= 10000:
        return None, "Servings must be between 1 and 10,000."
    address = (data.get("address") or "").strip()
    if not address:
        return None, "Add the pickup address."
    lat, lng = to_float(data.get("lat")), to_float(data.get("lng"))
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None, "Tap the map to mark the pickup spot."
    pickup = parse_iso(data.get("pickup_by"))
    now = utcnow()
    if not pickup or pickup <= now:
        return None, "Set a pickup deadline in the future."
    if pickup > now + MAX_PICKUP_WINDOW:
        return None, "Pickup deadline can be at most 48 hours away, to keep food safe."
    food_type = data.get("food_type") if data.get("food_type") in FOOD_TYPES else "Other"
    return {
        "title": title[:120],
        "description": (data.get("description") or "").strip()[:500],
        "food_type": food_type,
        "quantity": quantity,
        "address": address[:200],
        "lat": lat,
        "lng": lng,
        "pickup_by": iso(pickup),
    }, None


# ----------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    email = (d.get("email") or "").strip().lower()
    password = d.get("password") or ""
    role = d.get("role")
    if not name:
        return error("Enter your name.")
    if "@" not in email or "." not in email:
        return error("Enter a valid email address.")
    if len(password) < 6:
        return error("Use a password with at least 6 characters.")
    if role not in ROLES:
        return error("Choose whether you give food or collect it.")
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (name, email, phone, org, role, password_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                name[:80], email, (d.get("phone") or "").strip()[:30],
                (d.get("org") or "").strip()[:80], role,
                generate_password_hash(password), iso(utcnow()),
            ),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return error("An account with this email already exists.", 409)
    user = db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify({"token": make_token(user["id"]), "user": user_to_dict(user)}), 201


@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip().lower()
    user = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], d.get("password") or ""):
        return error("Email or password is incorrect.", 401)
    return jsonify({"token": make_token(user["id"]), "user": user_to_dict(user)})


@app.get("/api/me")
@require_auth()
def me():
    return jsonify({"user": user_to_dict(g.user)})


@app.get("/api/listings")
def list_listings():
    db = get_db()
    expire_old(db)
    viewer = current_user()
    status = request.args.get("status", "available")
    sql, params = LISTING_SQL, []
    if status == "all":
        if not viewer or viewer["role"] != "admin":
            return error("Only admins can view every listing.", 403)
    elif status in STATUSES:
        sql += " WHERE l.status = ?"
        params.append(status)
    else:
        return error("Unknown status.")
    rows = db.execute(sql + " ORDER BY l.pickup_by ASC", params).fetchall()
    lat, lng = to_float(request.args.get("lat")), to_float(request.args.get("lng"))
    items = [listing_to_dict(r, viewer, lat, lng) for r in rows]
    if lat is not None and lng is not None:
        items.sort(key=lambda x: x["distance_km"])
    return jsonify({"listings": items})


@app.post("/api/listings")
@require_auth("donor")
def create_listing():
    values, err = parse_listing(request.get_json(silent=True) or {})
    if err:
        return error(err)
    db = get_db()
    cur = db.execute(
        "INSERT INTO listings (donor_id, title, description, food_type, quantity, address, "
        "lat, lng, pickup_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            g.user["id"], values["title"], values["description"], values["food_type"],
            values["quantity"], values["address"], values["lat"], values["lng"],
            values["pickup_by"], iso(utcnow()),
        ),
    )
    db.commit()
    return jsonify({"listing": listing_to_dict(fetch_listing(db, cur.lastrowid), g.user)}), 201


@app.put("/api/listings/<int:listing_id>")
@require_auth("donor")
def update_listing(listing_id):
    db = get_db()
    row = fetch_listing(db, listing_id)
    if not row or row["donor_id"] != g.user["id"]:
        return error("Listing not found.", 404)
    if row["status"] != "available":
        return error("Only available listings can be edited.", 409)
    values, err = parse_listing(request.get_json(silent=True) or {})
    if err:
        return error(err)
    db.execute(
        "UPDATE listings SET title=?, description=?, food_type=?, quantity=?, address=?, "
        "lat=?, lng=?, pickup_by=? WHERE id=?",
        (
            values["title"], values["description"], values["food_type"], values["quantity"],
            values["address"], values["lat"], values["lng"], values["pickup_by"], listing_id,
        ),
    )
    db.commit()
    return jsonify({"listing": listing_to_dict(fetch_listing(db, listing_id), g.user)})


@app.delete("/api/listings/<int:listing_id>")
@require_auth("donor", "admin")
def delete_listing(listing_id):
    db = get_db()
    row = fetch_listing(db, listing_id)
    if not row or (g.user["role"] != "admin" and row["donor_id"] != g.user["id"]):
        return error("Listing not found.", 404)
    if row["status"] == "claimed":
        return error("Cancel the listing first, because someone has claimed it.", 409)
    db.execute("DELETE FROM listings WHERE id = ?", (listing_id,))
    db.commit()
    return jsonify({"ok": True})


def _transition(listing_id, sql, params, fail_message):
    """Run one guarded status change; the WHERE clause makes it race-safe."""
    db = get_db()
    expire_old(db)
    cur = db.execute(sql, params)
    db.commit()
    if cur.rowcount != 1:
        return error(fail_message, 409)
    return jsonify({"listing": listing_to_dict(fetch_listing(db, listing_id), g.user)})


@app.post("/api/listings/<int:listing_id>/claim")
@require_auth("receiver")
def claim(listing_id):
    return _transition(
        listing_id,
        "UPDATE listings SET status='claimed', claimed_by=?, claimed_at=? "
        "WHERE id=? AND status='available' AND pickup_by > ?",
        (g.user["id"], iso(utcnow()), listing_id, iso(utcnow())),
        "Someone else claimed this first, or the pickup window closed.",
    )


@app.post("/api/listings/<int:listing_id>/release")
@require_auth("receiver")
def release(listing_id):
    return _transition(
        listing_id,
        "UPDATE listings SET status='available', claimed_by=NULL, claimed_at=NULL "
        "WHERE id=? AND status='claimed' AND claimed_by=?",
        (listing_id, g.user["id"]),
        "You don't have an active claim on this listing.",
    )


@app.post("/api/listings/<int:listing_id>/complete")
@require_auth("donor", "receiver", "admin")
def complete(listing_id):
    return _transition(
        listing_id,
        "UPDATE listings SET status='completed', completed_at=? WHERE id=? AND status='claimed' "
        "AND (claimed_by=? OR donor_id=? OR ?='admin')",
        (iso(utcnow()), listing_id, g.user["id"], g.user["id"], g.user["role"]),
        "This listing can't be marked as picked up.",
    )


@app.post("/api/listings/<int:listing_id>/cancel")
@require_auth("donor", "admin")
def cancel(listing_id):
    return _transition(
        listing_id,
        "UPDATE listings SET status='cancelled' WHERE id=? "
        "AND status IN ('available', 'claimed') AND (donor_id=? OR ?='admin')",
        (listing_id, g.user["id"], g.user["role"]),
        "This listing can't be cancelled.",
    )


@app.get("/api/my")
@require_auth("donor", "receiver")
def my_listings():
    db = get_db()
    expire_old(db)
    column = "l.donor_id" if g.user["role"] == "donor" else "l.claimed_by"
    rows = db.execute(
        LISTING_SQL + f" WHERE {column} = ? ORDER BY l.created_at DESC", (g.user["id"],)
    ).fetchall()
    return jsonify({"listings": [listing_to_dict(r, g.user) for r in rows]})


@app.get("/api/stats")
def stats():
    db = get_db()
    expire_old(db)
    one = lambda sql: db.execute(sql).fetchone()[0] or 0  # noqa: E731
    return jsonify({
        "meals_shared": one("SELECT SUM(quantity) FROM listings WHERE status='completed'"),
        "pickups_completed": one("SELECT COUNT(*) FROM listings WHERE status='completed'"),
        "listed_now": one("SELECT COUNT(*) FROM listings WHERE status='available'"),
        "donors": one("SELECT COUNT(*) FROM users WHERE role='donor'"),
        "receivers": one("SELECT COUNT(*) FROM users WHERE role='receiver'"),
    })


@app.get("/api/admin/users")
@require_auth("admin")
def admin_users():
    rows = get_db().execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
    return jsonify({"users": [user_to_dict(r) for r in rows]})


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
