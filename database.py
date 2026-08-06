import sqlite3
import json
import logging
import random
import time
from datetime import datetime, timezone

import config

log = logging.getLogger(__name__)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS foods (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                name             TEXT    NOT NULL UNIQUE,
                kcal_per_100g    REAL    NOT NULL,
                protein_per_100g REAL    NOT NULL,
                carbs_per_100g   REAL    NOT NULL,
                fat_per_100g     REAL    NOT NULL,
                created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                last_used_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );

            -- One row per training session (one Telegram message = one session)
            CREATE TABLE IF NOT EXISTS workout_sessions (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_message_id INTEGER NOT NULL UNIQUE,
                date                TEXT    NOT NULL,
                comment             TEXT,
                created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_wsessions_msg ON workout_sessions(telegram_message_id);

            -- Individual exercises within a session
            -- weight_kg / weight_lbs: JSON arrays with one value per set (null for bodyweight)
            CREATE TABLE IF NOT EXISTS workout_exercises (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id    INTEGER NOT NULL REFERENCES workout_sessions(id),
                exercise_name TEXT    NOT NULL,
                sets          INTEGER NOT NULL,
                reps_per_set  TEXT    NOT NULL,
                weight_kg     TEXT,
                weight_lbs    TEXT,
                comment       TEXT,
                created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_wexercises_session ON workout_exercises(session_id);

            -- One row per named dish / meal event (multiple allowed per Telegram message)
            -- meal_name is null for single-ingredient entries (e.g. a protein shake)
            CREATE TABLE IF NOT EXISTS meal_sessions (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_message_id INTEGER NOT NULL,
                date                TEXT    NOT NULL,
                meal_name           TEXT,
                comment             TEXT,
                created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_msessions_msg ON meal_sessions(telegram_message_id);

            -- Individual ingredients / food items within a meal session
            CREATE TABLE IF NOT EXISTS meal_items (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   INTEGER NOT NULL REFERENCES meal_sessions(id),
                food_name    TEXT    NOT NULL,
                amount_grams REAL,
                kcal         REAL    NOT NULL,
                protein_g    REAL    NOT NULL,
                carbs_g      REAL    NOT NULL,
                fat_g        REAL    NOT NULL,
                is_estimated INTEGER NOT NULL,
                food_id      INTEGER REFERENCES foods(id),
                comment      TEXT,
                created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_mitems_session ON meal_items(session_id);

            -- Days the user added to the diary that don't (yet) have any meal.
            CREATE TABLE IF NOT EXISTS diary_days (
                date TEXT PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS processing_log (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                run_started_at     TEXT    NOT NULL,
                run_finished_at    TEXT,
                messages_processed INTEGER NOT NULL DEFAULT 0,
                api_input_tokens   INTEGER NOT NULL DEFAULT 0,
                api_output_tokens  INTEGER NOT NULL DEFAULT 0,
                errors             TEXT
            );

            CREATE TABLE IF NOT EXISTS pending_clarifications (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_message_id      INTEGER NOT NULL UNIQUE,
                original_message_id INTEGER NOT NULL,
                context             TEXT    NOT NULL,
                sent_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                resolved_at         TEXT
            );
        """)
        _migrate_legacy_tables(conn)
        _migrate_add_sort_order(conn)
        _migrate_add_activity_tables(conn)
        _migrate_add_recipe_tables(conn)
        _migrate_add_exercise_catalog(conn)
        _migrate_add_body_tables(conn)
        _migrate_add_food_v2(conn)
        _migrate_add_settings(conn)
        _migrate_food_estimated(conn)
        _migrate_round_nutrition(conn)
        _migrate_clear_stray_weight_unit(conn)
    log.debug("Database schema ready at %s", config.DB_PATH)


def _migrate_clear_stray_weight_unit(conn: sqlite3.Connection) -> None:
    """unit_weight_unit describes the size of a NAMED serving unit ("1 Dose =
    540 ml"). An earlier build also stamped it on plain g/ml foods, which made
    them look like millilitre foods. Clear it wherever no named unit exists."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(foods)").fetchall()}
    if "unit_weight_unit" not in cols:
        return
    conn.execute(
        "UPDATE foods SET unit_weight_unit = NULL "
        "WHERE unit_weight_unit IS NOT NULL "
        "  AND (unit_name IS NULL OR unit_name IN ('g', 'ml'))"
    )
    conn.commit()


def _migrate_food_estimated(conn: sqlite3.Connection) -> None:
    """Replace the four-way `category` label with a single `estimated` flag.

    Only one of the old categories carried behaviour: 'nebenbei' (low calorie
    density — a rough estimate is fine). That becomes estimated=1; the other
    labels were purely decorative and are dropped along with the column.

    Dropping is best-effort: on an SQLite too old for DROP COLUMN the legacy
    columns simply stay behind unused. They all have defaults, so writes that
    ignore them keep working and nothing breaks.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(foods)").fetchall()}
    if "estimated" not in cols:
        conn.execute("ALTER TABLE foods ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0")
        if "category" in cols:
            conn.execute("UPDATE foods SET estimated = 1 WHERE category = 'nebenbei'")
        elif "energy_density" in cols:      # even older schema
            conn.execute("UPDATE foods SET estimated = 1 WHERE energy_density = 'gering'")
    for dead in ("category", "energy_density", "focus"):
        if dead in cols:
            try:
                conn.execute(f"ALTER TABLE foods DROP COLUMN {dead}")
            except sqlite3.OperationalError:
                log.warning("Could not drop foods.%s — left in place, unused", dead)
    conn.commit()


def _migrate_add_food_v2(conn: sqlite3.Connection) -> None:
    """Foods: optional serving unit, energy density, tracking focus.
    Meal items: remember the unit the amount was entered in (display only —
    amount_grams stays the canonical value for all macro math)."""
    foods_cols = {r[1] for r in conn.execute("PRAGMA table_info(foods)").fetchall()}
    if "unit_name" not in foods_cols:
        conn.execute("ALTER TABLE foods ADD COLUMN unit_name TEXT")            # e.g. 'Stk.', 'Handvoll'
        conn.execute("ALTER TABLE foods ADD COLUMN unit_grams REAL")           # grams per unit
    if "unit_weight_unit" not in foods_cols:
        # Whether unit_grams is labelled as g or ml (both stored 1:1); display only.
        conn.execute("ALTER TABLE foods ADD COLUMN unit_weight_unit TEXT")
    # NOTE: energy_density/focus are NOT (re-)created here — they were folded
    # into `estimated` by _migrate_food_estimated, which drops them.
    item_cols = {r[1] for r in conn.execute("PRAGMA table_info(meal_items)").fetchall()}
    if "amount_units" not in item_cols:
        conn.execute("ALTER TABLE meal_items ADD COLUMN amount_units REAL")    # e.g. 2 (× Stk.)
        conn.execute("ALTER TABLE meal_items ADD COLUMN unit_name TEXT")
    conn.commit()


def _migrate_add_settings(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.commit()


def get_settings() -> dict:
    with _connect() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_settings(values: dict) -> None:
    with _connect() as conn:
        for k, v in values.items():
            if v is None or v == "":
                conn.execute("DELETE FROM settings WHERE key=?", (k,))
            else:
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (k, str(v)),
                )


def _migrate_add_sort_order(conn: sqlite3.Connection) -> None:
    """Add sort_order column to workout_exercises and meal_sessions if missing."""
    existing_we = {r[1] for r in conn.execute("PRAGMA table_info(workout_exercises)").fetchall()}
    if "sort_order" not in existing_we:
        conn.execute("ALTER TABLE workout_exercises ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        # Initialise: 0, 1, 2 … per session in current id order
        rows = conn.execute(
            "SELECT id, session_id FROM workout_exercises ORDER BY session_id, id"
        ).fetchall()
        counters: dict[int, int] = {}
        for r in rows:
            sid = r["session_id"]
            counters[sid] = counters.get(sid, 0)
            conn.execute("UPDATE workout_exercises SET sort_order=? WHERE id=?", (counters[sid], r["id"]))
            counters[sid] += 1

    existing_ms = {r[1] for r in conn.execute("PRAGMA table_info(meal_sessions)").fetchall()}
    if "sort_order" not in existing_ms:
        conn.execute("ALTER TABLE meal_sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        # No init needed — default 0 + date DESC tiebreak gives correct initial order


def _migrate_add_activity_tables(conn: sqlite3.Connection) -> None:
    """Create endurance_sessions and sport_sessions tables if they don't exist,
    and add msg_index column if missing (allows multiple sessions per Telegram message)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS endurance_sessions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            date          TEXT    NOT NULL,
            activity_type TEXT    NOT NULL CHECK(activity_type IN ('run','ride','swim')),
            distance_km   REAL,
            duration_s    INTEGER,
            elevation_m   REAL,
            avg_hr        INTEGER,
            kcal          REAL,
            comment       TEXT,
            sort_order    INTEGER NOT NULL DEFAULT 0,
            telegram_message_id INTEGER,
            msg_index     INTEGER NOT NULL DEFAULT 0
        )
    """)
    # Older DBs have a CHECK constraint without 'swim' — SQLite cannot alter
    # constraints, so rebuild the table once if needed.
    ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='endurance_sessions'"
    ).fetchone()
    if ddl and "'swim'" not in (ddl["sql"] or ""):
        conn.executescript("""
            ALTER TABLE endurance_sessions RENAME TO endurance_sessions_old;
            CREATE TABLE endurance_sessions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                date          TEXT    NOT NULL,
                activity_type TEXT    NOT NULL CHECK(activity_type IN ('run','ride','swim')),
                distance_km   REAL,
                duration_s    INTEGER,
                elevation_m   REAL,
                avg_hr        INTEGER,
                kcal          REAL,
                comment       TEXT,
                sort_order    INTEGER NOT NULL DEFAULT 0,
                telegram_message_id INTEGER,
                msg_index     INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO endurance_sessions
                (id, date, activity_type, distance_km, duration_s, elevation_m,
                 avg_hr, kcal, comment, sort_order, telegram_message_id, msg_index)
            SELECT id, date, activity_type, distance_km, duration_s, elevation_m,
                   avg_hr, kcal, comment, sort_order, telegram_message_id, msg_index
            FROM endurance_sessions_old;
            DROP TABLE endurance_sessions_old;
        """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sport_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date        TEXT    NOT NULL,
            sport_name  TEXT    NOT NULL,
            duration_s  INTEGER,
            avg_hr      INTEGER,
            kcal        REAL,
            comment     TEXT,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            telegram_message_id INTEGER,
            msg_index   INTEGER NOT NULL DEFAULT 0
        )
    """)
    # Add msg_index to existing tables if upgrading from older schema
    existing_en = {r[1] for r in conn.execute("PRAGMA table_info(endurance_sessions)").fetchall()}
    if "msg_index" not in existing_en:
        conn.execute("ALTER TABLE endurance_sessions ADD COLUMN msg_index INTEGER NOT NULL DEFAULT 0")
    existing_sp = {r[1] for r in conn.execute("PRAGMA table_info(sport_sessions)").fetchall()}
    if "msg_index" not in existing_sp:
        conn.execute("ALTER TABLE sport_sessions ADD COLUMN msg_index INTEGER NOT NULL DEFAULT 0")
    conn.commit()


def _migrate_add_recipe_tables(conn: sqlite3.Connection) -> None:
    """Create recipes and recipe_items tables if they don't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS recipes (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT    NOT NULL UNIQUE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS recipe_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            recipe_id   INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
            food_name   TEXT    NOT NULL,
            amount_grams REAL   NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0
        )
    """)
    rcols = {r[1] for r in conn.execute("PRAGMA table_info(recipes)").fetchall()}
    if "portions" not in rcols:
        conn.execute("ALTER TABLE recipes ADD COLUMN portions REAL")   # servings the recipe makes
    icols = {r[1] for r in conn.execute("PRAGMA table_info(recipe_items)").fetchall()}
    if "amount_units" not in icols:
        conn.execute("ALTER TABLE recipe_items ADD COLUMN amount_units REAL")   # amount as entered
        conn.execute("ALTER TABLE recipe_items ADD COLUMN unit_name TEXT")      # its display unit
    if "kcal" not in icols:
        # One-time ingredients not in the food catalog carry their own macros;
        # for regular ingredients these stay NULL and macros come from the food.
        conn.execute("ALTER TABLE recipe_items ADD COLUMN kcal REAL")
        conn.execute("ALTER TABLE recipe_items ADD COLUMN protein_g REAL")
        conn.execute("ALTER TABLE recipe_items ADD COLUMN carbs_g REAL")
        conn.execute("ALTER TABLE recipe_items ADD COLUMN fat_g REAL")
    conn.commit()


def _migrate_round_nutrition(conn: sqlite3.Connection) -> None:
    """One-off: round stored meal-item nutrition to the display precision
    (kcal → whole numbers, macros → 1 decimal) so inputs with step constraints
    accept the loaded values."""
    marker = conn.execute("SELECT value FROM settings WHERE key='nutrition_rounded_v1'").fetchone()
    if marker:
        return
    conn.execute("""
        UPDATE meal_items SET
            kcal      = ROUND(kcal),
            protein_g = ROUND(protein_g, 1),
            carbs_g   = ROUND(carbs_g, 1),
            fat_g     = ROUND(fat_g, 1)
    """)
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('nutrition_rounded_v1', '1')")
    conn.commit()


def _migrate_add_exercise_catalog(conn: sqlite3.Connection) -> None:
    """Create the exercise_catalog table and seed it from existing exercises."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS exercise_catalog (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
            comment      TEXT,
            created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            last_used_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
    """)
    # Add columns if upgrading from an earlier schema
    existing = {r[1] for r in conn.execute("PRAGMA table_info(exercise_catalog)").fetchall()}
    if "comment" not in existing:
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN comment TEXT")
    if "muscles" not in existing:
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN muscles TEXT")   # e.g. 'Brust, Trizeps'
    if "hints" not in existing:
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN hints TEXT")     # Ausführungshinweise
    if "is_strength" not in existing:
        # Kraftübung (1) vs Dehnübung (0) — only Kraftübungen get muscles/plots
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN is_strength INTEGER NOT NULL DEFAULT 1")
    if "muscle_group" not in existing:
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN muscle_group TEXT")       # Rücken/Core/Beine/Arme/Brust
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN secondary_muscles TEXT")  # Nebenmuskeln (muscles = Hauptmuskeln)
    # "pro Seite" is a property of the exercise itself (dumbbells etc.), not of
    # each logged set — the volume chart doubles it for the real load.
    if "per_hand" not in existing:
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN per_hand INTEGER NOT NULL DEFAULT 0")
        we_cols = {r[1] for r in conn.execute("PRAGMA table_info(workout_exercises)").fetchall()}
        if "per_hand" in we_cols:
            # carry over flags that were previously set on individual entries
            conn.execute(
                "UPDATE exercise_catalog SET per_hand=1 WHERE name IN "
                "(SELECT DISTINCT exercise_name FROM workout_exercises WHERE per_hand=1)"
            )
    # Isometric holds (planks, wall-sits, …): logged by duration, and the
    # analysis volume is total seconds held, not weight×reps (edits.txt #2).
    if "is_isometric" not in existing:
        conn.execute("ALTER TABLE exercise_catalog ADD COLUMN is_isometric INTEGER NOT NULL DEFAULT 0")
    # drop the obsolete per-entry column
    we_cols = {r[1] for r in conn.execute("PRAGMA table_info(workout_exercises)").fetchall()}
    if "per_hand" in we_cols:
        conn.execute("ALTER TABLE workout_exercises DROP COLUMN per_hand")
    # Per-set hold time for isometric exercises (JSON array, parallel to weights).
    if "duration_s" not in we_cols:
        conn.execute("ALTER TABLE workout_exercises ADD COLUMN duration_s TEXT")
    # Training plans: reusable workout templates
    conn.execute("""
        CREATE TABLE IF NOT EXISTS training_plans (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT    NOT NULL UNIQUE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS training_plan_items (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id       INTEGER NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
            exercise_name TEXT    NOT NULL,
            sets          INTEGER NOT NULL,
            reps_str      TEXT    NOT NULL,
            weight_str    TEXT,
            weight_unit   TEXT    NOT NULL DEFAULT 'kg',
            per_hand      INTEGER NOT NULL DEFAULT 0,
            sort_order    INTEGER NOT NULL DEFAULT 0
        )
    """)
    # Seed from distinct names already used in workouts (first run only)
    count = conn.execute("SELECT COUNT(*) FROM exercise_catalog").fetchone()[0]
    if count == 0:
        names = conn.execute(
            "SELECT DISTINCT exercise_name FROM workout_exercises WHERE exercise_name IS NOT NULL"
        ).fetchall()
        for r in names:
            conn.execute(
                "INSERT OR IGNORE INTO exercise_catalog (name) VALUES (?)", (r["exercise_name"],)
            )
    conn.commit()


def _migrate_add_body_tables(conn: sqlite3.Connection) -> None:
    """Create body-tracking tables (weight, measurements, progress photos)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS body_weight (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            date      TEXT    NOT NULL,
            weight_kg REAL    NOT NULL,
            comment   TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS body_measurements (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            date  TEXT NOT NULL,
            name  TEXT NOT NULL,
            value REAL NOT NULL,
            unit  TEXT NOT NULL DEFAULT 'cm'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS body_photos (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            date       TEXT NOT NULL,
            filename   TEXT NOT NULL,
            comment    TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
    """)
    conn.commit()


def _migrate_legacy_tables(conn: sqlite3.Connection) -> None:
    """Migrate flat workouts/meals tables (old schema) to hierarchical schema."""
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

    if "workouts" in tables:
        log.info("Migrating legacy 'workouts' table to workout_sessions + workout_exercises ...")
        sessions = conn.execute(
            "SELECT DISTINCT telegram_message_id, entry_date, created_at FROM workouts ORDER BY telegram_message_id"
        ).fetchall()
        for s in sessions:
            cur = conn.execute(
                "INSERT OR IGNORE INTO workout_sessions (telegram_message_id, date, created_at) VALUES (?, ?, ?)",
                (s["telegram_message_id"], s["entry_date"], s["created_at"])
            )
            session_id = cur.lastrowid or conn.execute(
                "SELECT id FROM workout_sessions WHERE telegram_message_id=?", (s["telegram_message_id"],)
            ).fetchone()["id"]
            for ex in conn.execute("SELECT * FROM workouts WHERE telegram_message_id=?", (s["telegram_message_id"],)).fetchall():
                sets = ex["sets"]
                conn.execute("""
                    INSERT INTO workout_exercises
                        (session_id, exercise_name, sets, reps_per_set, weight_kg, weight_lbs, comment, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (session_id, ex["exercise_name"], sets, ex["reps_per_set"],
                      _single_to_weight_array(ex["weight_kg"], sets),
                      _single_to_weight_array(ex["weight_lbs"], sets),
                      ex["comment"], ex["created_at"]))
        conn.execute("DROP TABLE workouts")
        log.info("Legacy 'workouts' migration done.")

    if "meals" in tables:
        log.info("Migrating legacy 'meals' table to meal_sessions + meal_items ...")
        groups = conn.execute(
            "SELECT DISTINCT telegram_message_id, entry_date, created_at FROM meals ORDER BY telegram_message_id"
        ).fetchall()
        for g in groups:
            cur = conn.execute(
                "INSERT INTO meal_sessions (telegram_message_id, date, created_at) VALUES (?, ?, ?)",
                (g["telegram_message_id"], g["entry_date"], g["created_at"])
            )
            session_id = cur.lastrowid
            for m in conn.execute("SELECT * FROM meals WHERE telegram_message_id=?", (g["telegram_message_id"],)).fetchall():
                conn.execute("""
                    INSERT INTO meal_items
                        (session_id, food_name, amount_grams, kcal, protein_g, carbs_g, fat_g,
                         is_estimated, food_id, comment, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (session_id, m["food_name"], m["amount_grams"], m["kcal"],
                      m["protein_g"], m["carbs_g"], m["fat_g"], m["is_estimated"],
                      m["food_id"], m["comment"], m["created_at"]))
        conn.execute("DROP TABLE meals")
        log.info("Legacy 'meals' migration done.")


# ── foods ──────────────────────────────────────────────────────────────────

def get_all_foods() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, "
            "unit_name, unit_grams, unit_weight_unit, estimated FROM foods ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]


def _cap(s: str) -> str:
    """Title-case a food/ingredient name for consistent storage."""
    return s.title() if s else s


def upsert_food(name: str, kcal: float, protein: float, carbs: float, fat: float,
                unit_name: str | None = None, unit_grams: float | None = None,
                estimated: bool | None = None, unit_weight_unit: str | None = None) -> int:
    name = _cap(name)
    now = _now()
    with _connect() as conn:
        conn.execute("""
            INSERT INTO foods (name, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
                               unit_name, unit_grams, unit_weight_unit, estimated, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                kcal_per_100g    = excluded.kcal_per_100g,
                protein_per_100g = excluded.protein_per_100g,
                carbs_per_100g   = excluded.carbs_per_100g,
                fat_per_100g     = excluded.fat_per_100g,
                -- keep existing serving/classification when the caller sends none
                -- (auto-registration from meal items knows nothing about units)
                unit_name        = COALESCE(excluded.unit_name, foods.unit_name),
                unit_grams       = COALESCE(excluded.unit_grams, foods.unit_grams),
                unit_weight_unit = COALESCE(excluded.unit_weight_unit, foods.unit_weight_unit),
                last_used_at     = excluded.last_used_at
        """, (name, kcal, protein, carbs, fat,
              unit_name, unit_grams, unit_weight_unit, estimated, now, now))
        if estimated is not None:
            conn.execute("UPDATE foods SET estimated=? WHERE LOWER(name)=LOWER(?)", (int(estimated), name))
        row = conn.execute("SELECT id FROM foods WHERE LOWER(name)=LOWER(?)", (name,)).fetchone()
    return row["id"]


def update_food(food_id: int, name: str, kcal: float, protein: float, carbs: float, fat: float,
                unit_name: str | None = None, unit_grams: float | None = None,
                estimated: bool = False, unit_weight_unit: str | None = None) -> None:
    cap_name = _cap(name)
    with _connect() as conn:
        old = conn.execute("SELECT name FROM foods WHERE id=?", (food_id,)).fetchone()
        old_name = old["name"] if old else cap_name
        conn.execute(
            "UPDATE foods SET name=?, kcal_per_100g=?, protein_per_100g=?, carbs_per_100g=?, fat_per_100g=?, "
            "unit_name=?, unit_grams=?, unit_weight_unit=?, estimated=? WHERE id=?",
            (cap_name, kcal, protein, carbs, fat,
             unit_name, unit_grams, unit_weight_unit, int(estimated), food_id),
        )
        # Diary entries are immutable snapshots: editing a food's nutrition or
        # name must NOT retroactively change already-logged meal_items — only
        # future diary inputs use the updated values (edits.txt #4).
        #
        # Recipes, however, recompute macros live from the catalog, so a rename
        # must still follow through to recipe_items or the ingredient would stop
        # resolving (its macros would silently drop to zero).
        if old_name.lower() != cap_name.lower():
            conn.execute(
                "UPDATE recipe_items SET food_name = ? WHERE LOWER(food_name) = LOWER(?)",
                (cap_name, old_name),
            )


def delete_food(food_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM foods WHERE id=?", (food_id,))


def get_food_by_name(name: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM foods WHERE LOWER(name)=LOWER(?)", (name,)).fetchone()
    return dict(row) if row else None


def _auto_upsert_food(food_name: str, amount_grams: float | None,
                      kcal: float, protein_g: float, carbs_g: float, fat_g: float) -> None:
    """Register a food in the catalog from a meal item if it isn't there yet."""
    if not amount_grams or amount_grams <= 0:
        return
    if get_food_by_name(food_name):
        return  # already known — don't overwrite hand-entered per-100g values
    factor = 100.0 / amount_grams
    upsert_food(food_name, kcal * factor, protein_g * factor, carbs_g * factor, fat_g * factor)


# ── workout sessions & exercises ───────────────────────────────────────────

def insert_workout_exercise(
    session_id: int,
    exercise_name: str,
    sets: int,
    reps_per_set: list[int],
    weight_kg: list[float | None] | None,
    weight_lbs: list[float | None] | None,
    comment: str | None,
    duration_s: list[float | None] | None = None,
) -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order)+1, 0) AS next FROM workout_exercises WHERE session_id=?",
            (session_id,)
        ).fetchone()
        cur = conn.execute("""
            INSERT INTO workout_exercises
                (session_id, exercise_name, sets, reps_per_set, weight_kg, weight_lbs, comment, duration_s, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (session_id, exercise_name, sets, json.dumps(reps_per_set),
              json.dumps(weight_kg) if weight_kg is not None else None,
              json.dumps(weight_lbs) if weight_lbs is not None else None,
              comment,
              json.dumps(duration_s) if duration_s is not None else None,
              row["next"]))
    _auto_upsert_exercise(exercise_name)
    return cur.lastrowid


def _single_to_weight_array(weight: float | None, sets: int) -> str | None:
    """Convert a legacy single-float weight to a JSON array for migration."""
    if weight is None:
        return None
    return json.dumps([round(float(weight), 1)] * sets)


# ── exercise catalog ───────────────────────────────────────────────────────

def get_all_exercises() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, comment, muscles, hints, per_hand, "
            "is_strength, is_isometric, muscle_group, secondary_muscles FROM exercise_catalog ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_exercise(name: str, comment: str | None = None, muscles: str | None = None,
                    per_hand: bool | None = None, hints: str | None = None,
                    is_strength: bool | None = None, muscle_group: str | None = None,
                    secondary_muscles: str | None = None,
                    is_isometric: bool | None = None) -> int:
    """Insert an exercise name into the catalog (keeps existing attributes if any).

    per_hand / is_strength are only written when explicitly given, so
    auto-registration from a workout entry never resets flags set in the editor."""
    name = name.strip()
    now = _now()
    with _connect() as conn:
        conn.execute("""
            INSERT INTO exercise_catalog (name, comment, muscles, hints, muscle_group, secondary_muscles,
                                          created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                last_used_at      = excluded.last_used_at,
                comment           = COALESCE(excluded.comment, exercise_catalog.comment),
                muscles           = COALESCE(excluded.muscles, exercise_catalog.muscles),
                hints             = COALESCE(excluded.hints, exercise_catalog.hints),
                muscle_group      = COALESCE(excluded.muscle_group, exercise_catalog.muscle_group),
                secondary_muscles = COALESCE(excluded.secondary_muscles, exercise_catalog.secondary_muscles)
        """, (name, comment, muscles, hints, muscle_group, secondary_muscles, now, now))
        if per_hand is not None:
            conn.execute("UPDATE exercise_catalog SET per_hand=? WHERE name=? COLLATE NOCASE",
                         (int(per_hand), name))
        if is_strength is not None:
            conn.execute("UPDATE exercise_catalog SET is_strength=? WHERE name=? COLLATE NOCASE",
                         (int(is_strength), name))
        if is_isometric is not None:
            conn.execute("UPDATE exercise_catalog SET is_isometric=? WHERE name=? COLLATE NOCASE",
                         (int(is_isometric), name))
        row = conn.execute(
            "SELECT id FROM exercise_catalog WHERE name=? COLLATE NOCASE", (name,)
        ).fetchone()
    return row["id"]


def update_exercise_catalog(exercise_id: int, name: str, comment: str | None,
                            muscles: str | None = None, per_hand: bool = False,
                            hints: str | None = None, is_strength: bool = True,
                            muscle_group: str | None = None,
                            secondary_muscles: str | None = None,
                            is_isometric: bool = False) -> None:
    """Rename a catalog entry, set its attributes, and propagate the rename to workouts."""
    name = name.strip()
    with _connect() as conn:
        old = conn.execute(
            "SELECT name FROM exercise_catalog WHERE id=?", (exercise_id,)
        ).fetchone()
        old_name = old["name"] if old else name
        conn.execute(
            "UPDATE exercise_catalog SET name=?, comment=?, muscles=?, per_hand=?, hints=?, "
            "is_strength=?, muscle_group=?, secondary_muscles=?, is_isometric=? WHERE id=?",
            (name, comment, muscles, int(per_hand), hints,
             int(is_strength), muscle_group, secondary_muscles, int(is_isometric), exercise_id),
        )
        conn.execute(
            "UPDATE workout_exercises SET exercise_name=? WHERE exercise_name=? COLLATE NOCASE",
            (name, old_name),
        )


def delete_exercise_catalog(exercise_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM exercise_catalog WHERE id=?", (exercise_id,))


def _auto_upsert_exercise(name: str) -> None:
    """Register an exercise name in the catalog from a workout entry."""
    if name and name.strip():
        upsert_exercise(name)


# ── meal sessions & items ──────────────────────────────────────────────────

def insert_meal_item(
    session_id: int,
    food_name: str,
    amount_grams: float | None,
    kcal: float,
    protein_g: float,
    carbs_g: float,
    fat_g: float,
    is_estimated: bool,
    food_id: int | None,
    comment: str | None,
    skip_food_db: bool = False,
    amount_units: float | None = None,
    unit_name: str | None = None,
) -> int:
    with _connect() as conn:
        cur = conn.execute("""
            INSERT INTO meal_items
                (session_id, food_name, amount_grams, kcal, protein_g, carbs_g, fat_g,
                 is_estimated, food_id, comment, amount_units, unit_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (session_id, _cap(food_name), amount_grams, kcal, protein_g, carbs_g, fat_g,
              int(is_estimated), food_id, comment, amount_units, unit_name))
    if not skip_food_db:
        _auto_upsert_food(food_name, amount_grams, kcal, protein_g, carbs_g, fat_g)
    return cur.lastrowid


# ── UI CRUD ────────────────────────────────────────────────────────────────
# UI-created entries need a fake telegram_message_id (negative, never collides
# with real Telegram IDs which are positive integers).

def _ui_message_id() -> int:
    return -(int(time.time() * 1000) * 1000 + random.randint(0, 999))


def get_all_workout_sessions_full() -> list[dict]:
    """All workout sessions with exercises, newest first."""
    with _connect() as conn:
        sessions = conn.execute(
            "SELECT id, date, comment, created_at FROM workout_sessions ORDER BY date DESC, id DESC"
        ).fetchall()
        result = []
        for s in sessions:
            exercises = conn.execute(
                "SELECT id, exercise_name, sets, reps_per_set, weight_kg, weight_lbs, comment, duration_s "
                "FROM workout_exercises WHERE session_id=? ORDER BY sort_order, id",
                (s["id"],)
            ).fetchall()
            d = dict(s)
            d["exercises"] = [dict(e) for e in exercises]
            result.append(d)
    return result


def insert_workout_session_ui(date: str, comment: str | None = None) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO workout_sessions (telegram_message_id, date, comment) VALUES (?, ?, ?)",
            (_ui_message_id(), date, comment)
        )
    return cur.lastrowid


def update_workout_session(session_id: int, date: str, comment: str | None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE workout_sessions SET date=?, comment=? WHERE id=?",
            (date, comment, session_id)
        )


def delete_workout_session(session_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM workout_exercises WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM workout_sessions WHERE id=?", (session_id,))


def update_workout_exercise(
    exercise_id: int,
    exercise_name: str,
    sets: int,
    reps_per_set: list[int],
    weight_kg: list[float | None] | None,
    weight_lbs: list[float | None] | None,
    comment: str | None,
    duration_s: list[float | None] | None = None,
) -> None:
    with _connect() as conn:
        conn.execute("""
            UPDATE workout_exercises
            SET exercise_name=?, sets=?, reps_per_set=?, weight_kg=?, weight_lbs=?, comment=?, duration_s=?
            WHERE id=?
        """, (exercise_name, sets, json.dumps(reps_per_set),
              json.dumps(weight_kg) if weight_kg is not None else None,
              json.dumps(weight_lbs) if weight_lbs is not None else None,
              comment,
              json.dumps(duration_s) if duration_s is not None else None,
              exercise_id))
    _auto_upsert_exercise(exercise_name)


def delete_workout_exercise(exercise_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM workout_exercises WHERE id=?", (exercise_id,))


def get_all_meal_sessions_full() -> list[dict]:
    """All meal sessions with items. Within a day, oldest-added first so newly
    added meals append to the bottom (id ASC tiebreak)."""
    with _connect() as conn:
        sessions = conn.execute(
            "SELECT id, date, meal_name, comment, created_at FROM meal_sessions "
            "ORDER BY sort_order ASC, date DESC, id ASC"
        ).fetchall()
        result = []
        for s in sessions:
            items = conn.execute(
                "SELECT id, food_name, amount_grams, kcal, protein_g, carbs_g, fat_g, is_estimated, comment, "
                "amount_units, unit_name "
                "FROM meal_items WHERE session_id=? ORDER BY id",
                (s["id"],)
            ).fetchall()
            d = dict(s)
            d["items"] = [dict(i) for i in items]
            result.append(d)
    return result


def insert_meal_session_ui(date: str, meal_name: str | None, comment: str | None = None) -> int:
    with _connect() as conn:
        nxt = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM meal_sessions").fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO meal_sessions (telegram_message_id, date, meal_name, comment, sort_order) VALUES (?, ?, ?, ?, ?)",
            (_ui_message_id(), date, meal_name, comment, nxt)
        )
    return cur.lastrowid


def update_meal_session(session_id: int, date: str, meal_name: str | None, comment: str | None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE meal_sessions SET date=?, meal_name=?, comment=? WHERE id=?",
            (date, meal_name, comment, session_id)
        )


def delete_meal_session(session_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM meal_items WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM meal_sessions WHERE id=?", (session_id,))


# ── Empty diary days (a day added without any meal yet) ─────────────────────

def get_diary_days() -> list[str]:
    with _connect() as conn:
        return [r["date"] for r in conn.execute("SELECT date FROM diary_days").fetchall()]


def add_diary_day(date: str) -> None:
    with _connect() as conn:
        conn.execute("INSERT OR IGNORE INTO diary_days (date) VALUES (?)", (date,))


def delete_diary_day(date: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM diary_days WHERE date=?", (date,))


def update_meal_item(
    item_id: int,
    food_name: str,
    amount_grams: float | None,
    kcal: float,
    protein_g: float,
    carbs_g: float,
    fat_g: float,
    is_estimated: bool,
    comment: str | None,
    skip_food_db: bool = False,
    amount_units: float | None = None,
    unit_name: str | None = None,
) -> None:
    with _connect() as conn:
        conn.execute("""
            UPDATE meal_items
            SET food_name=?, amount_grams=?, kcal=?, protein_g=?, carbs_g=?,
                fat_g=?, is_estimated=?, comment=?, amount_units=?, unit_name=?
            WHERE id=?
        """, (_cap(food_name), amount_grams, kcal, protein_g, carbs_g, fat_g,
              int(is_estimated), comment, amount_units, unit_name, item_id))
    if not skip_food_db:
        _auto_upsert_food(food_name, amount_grams, kcal, protein_g, carbs_g, fat_g)


def delete_meal_item(item_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM meal_items WHERE id=?", (item_id,))


def reorder_workout_exercises(session_id: int, ordered_ids: list[int]) -> None:
    """Persist a new exercise order for a session (ordered_ids = IDs from top to bottom)."""
    with _connect() as conn:
        for i, ex_id in enumerate(ordered_ids):
            conn.execute(
                "UPDATE workout_exercises SET sort_order=? WHERE id=? AND session_id=?",
                (i, ex_id, session_id)
            )


def reorder_meal_sessions(ordered_ids: list[int]) -> None:
    """Persist a new meal-session order (ordered_ids = IDs from top to bottom)."""
    with _connect() as conn:
        for i, sess_id in enumerate(ordered_ids):
            conn.execute("UPDATE meal_sessions SET sort_order=? WHERE id=?", (i, sess_id))


# ── endurance sessions ────────────────────────────────────────────────────

def get_all_endurance_sessions() -> list[dict]:
    """All endurance sessions, newest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM endurance_sessions ORDER BY sort_order ASC, date DESC, id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def insert_endurance_session(
    date: str,
    activity_type: str,
    distance_km: float | None,
    duration_s: int | None,
    elevation_m: float | None,
    avg_hr: int | None,
    kcal: float | None,
    comment: str | None,
    telegram_message_id: int | None = None,
    msg_index: int = 0,
) -> int:
    with _connect() as conn:
        cur = conn.execute("""
            INSERT INTO endurance_sessions
                (date, activity_type, distance_km, duration_s, elevation_m,
                 avg_hr, kcal, comment, telegram_message_id, msg_index)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (date, activity_type, distance_km, duration_s, elevation_m,
              avg_hr, kcal, comment, telegram_message_id, msg_index))
    return cur.lastrowid


def update_endurance_session(
    session_id: int,
    date: str,
    activity_type: str,
    distance_km: float | None,
    duration_s: int | None,
    elevation_m: float | None,
    avg_hr: int | None,
    kcal: float | None,
    comment: str | None,
) -> None:
    with _connect() as conn:
        conn.execute("""
            UPDATE endurance_sessions
            SET date=?, activity_type=?, distance_km=?, duration_s=?,
                elevation_m=?, avg_hr=?, kcal=?, comment=?
            WHERE id=?
        """, (date, activity_type, distance_km, duration_s, elevation_m,
              avg_hr, kcal, comment, session_id))


def delete_endurance_session(session_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM endurance_sessions WHERE id=?", (session_id,))


def reorder_endurance_sessions(ordered_ids: list[int]) -> None:
    with _connect() as conn:
        for i, sid in enumerate(ordered_ids):
            conn.execute("UPDATE endurance_sessions SET sort_order=? WHERE id=?", (i, sid))


# ── sport sessions ────────────────────────────────────────────────────────

def get_all_sport_sessions() -> list[dict]:
    """All hobby-sport sessions, newest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM sport_sessions ORDER BY sort_order ASC, date DESC, id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def insert_sport_session(
    date: str,
    sport_name: str,
    duration_s: int | None,
    avg_hr: int | None,
    kcal: float | None,
    comment: str | None,
    telegram_message_id: int | None = None,
    msg_index: int = 0,
) -> int:
    with _connect() as conn:
        cur = conn.execute("""
            INSERT INTO sport_sessions
                (date, sport_name, duration_s, avg_hr, kcal, comment, telegram_message_id, msg_index)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (date, sport_name, duration_s, avg_hr, kcal, comment, telegram_message_id, msg_index))
    return cur.lastrowid


def update_sport_session(
    session_id: int,
    date: str,
    sport_name: str,
    duration_s: int | None,
    avg_hr: int | None,
    kcal: float | None,
    comment: str | None,
) -> None:
    with _connect() as conn:
        conn.execute("""
            UPDATE sport_sessions
            SET date=?, sport_name=?, duration_s=?, avg_hr=?, kcal=?, comment=?
            WHERE id=?
        """, (date, sport_name, duration_s, avg_hr, kcal, comment, session_id))


def delete_sport_session(session_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM sport_sessions WHERE id=?", (session_id,))


def reorder_sport_sessions(ordered_ids: list[int]) -> None:
    with _connect() as conn:
        for i, sid in enumerate(ordered_ids):
            conn.execute("UPDATE sport_sessions SET sort_order=? WHERE id=?", (i, sid))


# ── Recipes ────────────────────────────────────────────────────────────────

def get_all_recipes() -> list[dict]:
    with _connect() as conn:
        recipes = [dict(r) for r in conn.execute("SELECT * FROM recipes ORDER BY name").fetchall()]
        for r in recipes:
            r["items"] = [dict(i) for i in conn.execute(
                "SELECT * FROM recipe_items WHERE recipe_id=? ORDER BY sort_order, id",
                (r["id"],)
            ).fetchall()]
    return recipes


def upsert_recipe(recipe_id: int | None, name: str, items: list[dict],
                  portions: float | None = None) -> int:
    """Create (recipe_id=None) or replace a recipe with the given items."""
    with _connect() as conn:
        # Recipe names are stored exactly as entered (no auto-capitalisation).
        if recipe_id is None:
            cur = conn.execute("INSERT INTO recipes (name, portions) VALUES (?, ?)", (name, portions))
            rid = cur.lastrowid
        else:
            conn.execute("UPDATE recipes SET name=?, portions=? WHERE id=?", (name, portions, recipe_id))
            rid = recipe_id
        conn.execute("DELETE FROM recipe_items WHERE recipe_id=?", (rid,))
        for i, item in enumerate(items):
            conn.execute(
                "INSERT INTO recipe_items "
                "(recipe_id, food_name, amount_grams, amount_units, unit_name, "
                " kcal, protein_g, carbs_g, fat_g, sort_order) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (rid, _cap(item["food_name"]), item["amount_grams"],
                 item.get("amount_units"), item.get("unit_name"),
                 item.get("kcal"), item.get("protein_g"),
                 item.get("carbs_g"), item.get("fat_g"), i),
            )
    return rid


def delete_recipe(recipe_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM recipe_items WHERE recipe_id=?", (recipe_id,))
        conn.execute("DELETE FROM recipes WHERE id=?", (recipe_id,))


# ── Body tracking ──────────────────────────────────────────────────────────

def get_all_body_weight() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM body_weight ORDER BY date DESC, id DESC").fetchall()
    return [dict(r) for r in rows]


def insert_body_weight(date: str, weight_kg: float, comment: str | None) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO body_weight (date, weight_kg, comment) VALUES (?, ?, ?)",
            (date, weight_kg, comment),
        )
    return cur.lastrowid


def update_body_weight(entry_id: int, date: str, weight_kg: float, comment: str | None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE body_weight SET date=?, weight_kg=?, comment=? WHERE id=?",
            (date, weight_kg, comment, entry_id),
        )


def delete_body_weight(entry_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM body_weight WHERE id=?", (entry_id,))


def get_all_body_measurements() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM body_measurements ORDER BY date DESC, id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def insert_body_measurement(date: str, name: str, value: float, unit: str) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO body_measurements (date, name, value, unit) VALUES (?, ?, ?, ?)",
            (date, name, value, unit),
        )
    return cur.lastrowid


def update_body_measurement(entry_id: int, date: str, name: str, value: float, unit: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE body_measurements SET date=?, name=?, value=?, unit=? WHERE id=?",
            (date, name, value, unit, entry_id),
        )


def delete_body_measurement(entry_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM body_measurements WHERE id=?", (entry_id,))


def get_all_body_photos() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM body_photos ORDER BY date DESC, id DESC").fetchall()
    return [dict(r) for r in rows]


def insert_body_photo(date: str, filename: str, comment: str | None) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO body_photos (date, filename, comment) VALUES (?, ?, ?)",
            (date, filename, comment),
        )
    return cur.lastrowid


def delete_body_photo(photo_id: int) -> str | None:
    """Delete the DB row and return the filename so the caller can remove the file."""
    with _connect() as conn:
        row = conn.execute("SELECT filename FROM body_photos WHERE id=?", (photo_id,)).fetchone()
        conn.execute("DELETE FROM body_photos WHERE id=?", (photo_id,))
    return row["filename"] if row else None


# ── Training plans ─────────────────────────────────────────────────────────
# Reusable workout templates: exercise + sets/reps/weight as entered in the UI.

def get_all_training_plans() -> list[dict]:
    with _connect() as conn:
        plans = [dict(r) for r in conn.execute("SELECT * FROM training_plans ORDER BY name").fetchall()]
        for p in plans:
            p["items"] = [dict(i) for i in conn.execute(
                "SELECT * FROM training_plan_items WHERE plan_id=? ORDER BY sort_order, id",
                (p["id"],)
            ).fetchall()]
    return plans


def upsert_training_plan(plan_id: int | None, name: str, items: list[dict]) -> int:
    """Create (plan_id=None) or replace a training plan with the given items."""
    with _connect() as conn:
        if plan_id is None:
            cur = conn.execute("INSERT INTO training_plans (name) VALUES (?)", (name.strip(),))
            pid = cur.lastrowid
        else:
            conn.execute("UPDATE training_plans SET name=? WHERE id=?", (name.strip(), plan_id))
            pid = plan_id
        conn.execute("DELETE FROM training_plan_items WHERE plan_id=?", (pid,))
        for i, item in enumerate(items):
            conn.execute("""
                INSERT INTO training_plan_items
                    (plan_id, exercise_name, sets, reps_str, weight_str, weight_unit, per_hand, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (pid, item["exercise_name"], item["sets"], item["reps_str"],
                  item.get("weight_str"), item.get("weight_unit", "kg"),
                  int(item.get("per_hand", False)), i))
    return pid


def delete_training_plan(plan_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM training_plan_items WHERE plan_id=?", (plan_id,))
        conn.execute("DELETE FROM training_plans WHERE id=?", (plan_id,))


# ── helpers ────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
