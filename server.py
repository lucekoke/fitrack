"""
fitrack – FastAPI UI server
Usage: venv\\Scripts\\python -m uvicorn server:app --reload --port 8000
Then open: http://localhost:8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database as db

STATIC  = Path(__file__).parent / "static"
UPLOADS = Path(__file__).parent / "uploads"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    UPLOADS.mkdir(exist_ok=True)
    yield


app = FastAPI(title="fitrack", lifespan=lifespan)


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
UPLOADS.mkdir(exist_ok=True)  # must exist before mounting
app.mount("/uploads", StaticFiles(directory=str(UPLOADS)), name="uploads")


@app.get("/")
async def root():
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# ── Helpers ────────────────────────────────────────────────────────────────

def _parse_reps(reps_str: str, sets: int) -> list[int]:
    parts = [p.strip() for p in reps_str.split(",") if p.strip()]
    if len(parts) == 1:
        return [int(parts[0])] * sets
    return [int(p) for p in parts]


def _parse_weight(weight_str: str | None, sets: int) -> list[float | None] | None:
    if not weight_str or not weight_str.strip():
        return None
    parts = [p.strip() for p in weight_str.split(",") if p.strip()]
    if len(parts) == 1:
        return [round(float(parts[0]), 1)] * sets
    return [round(float(p), 1) for p in parts]


def _kg_to_lbs(weight_kg: list[float | None] | None) -> list[float | None] | None:
    if weight_kg is None:
        return None
    return [round(v * 2.20462, 1) if v is not None else None for v in weight_kg]


def _lbs_to_kg(weight_lbs: list[float | None] | None) -> list[float | None] | None:
    if weight_lbs is None:
        return None
    return [round(v / 2.20462, 1) if v is not None else None for v in weight_lbs]


# ── Pydantic models ────────────────────────────────────────────────────────

class ExerciseIn(BaseModel):
    exercise_name: str
    sets: int
    reps_str: str
    weight_str: str | None = None
    weight_unit: str = "kg"   # "kg" or "lbs"
    comment: str | None = None


class WorkoutSessionIn(BaseModel):
    date: str
    comment: str | None = None


class MealItemIn(BaseModel):
    food_name: str
    amount_grams: float | None = None
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float
    is_estimated: bool = False
    comment: str | None = None
    skip_food_db: bool = False
    amount_units: float | None = None   # amount as entered, e.g. 2 (× Stk.)
    unit_name: str | None = None        # display unit, e.g. 'Stk.', 'Handvoll'


class MealSessionIn(BaseModel):
    date: str
    meal_name: str | None = None
    comment: str | None = None


class ReorderIn(BaseModel):
    ids: list[int]


class EnduranceSessionIn(BaseModel):
    date: str
    activity_type: str          # 'run' or 'ride'
    distance_km: float | None = None
    duration_s: int | None = None
    elevation_m: float | None = None
    avg_hr: int | None = None
    kcal: float | None = None
    comment: str | None = None


class SportSessionIn(BaseModel):
    date: str
    sport_name: str
    duration_s: int | None = None
    avg_hr: int | None = None
    kcal: float | None = None
    comment: str | None = None


# ── Workout endpoints ──────────────────────────────────────────────────────

@app.get("/api/workouts")
def get_workouts():
    return db.get_all_workout_sessions_full()


@app.post("/api/workouts", status_code=201)
def create_workout(body: WorkoutSessionIn):
    session_id = db.insert_workout_session_ui(body.date, body.comment)
    return {"id": session_id}


@app.put("/api/workouts/{session_id}")
def update_workout(session_id: int, body: WorkoutSessionIn):
    db.update_workout_session(session_id, body.date, body.comment)
    return {"ok": True}


@app.delete("/api/workouts/{session_id}")
def delete_workout(session_id: int):
    db.delete_workout_session(session_id)
    return {"ok": True}


def _resolve_weights(weight_str: str | None, weight_unit: str, sets: int):
    """Return (weight_kg, weight_lbs) arrays from user input + chosen unit."""
    raw = _parse_weight(weight_str, sets)
    if raw is None:
        return None, None
    if weight_unit == "lbs":
        return _lbs_to_kg(raw), raw
    return raw, _kg_to_lbs(raw)


@app.post("/api/workouts/{session_id}/exercises", status_code=201)
def add_exercise(session_id: int, body: ExerciseIn):
    reps = _parse_reps(body.reps_str, body.sets)
    wkg, wlbs = _resolve_weights(body.weight_str, body.weight_unit, body.sets)
    ex_id = db.insert_workout_exercise(
        session_id, body.exercise_name, body.sets, reps, wkg, wlbs, body.comment
    )
    return {"id": ex_id}


@app.put("/api/exercises/{exercise_id}")
def update_exercise(exercise_id: int, body: ExerciseIn):
    reps = _parse_reps(body.reps_str, body.sets)
    wkg, wlbs = _resolve_weights(body.weight_str, body.weight_unit, body.sets)
    db.update_workout_exercise(
        exercise_id, body.exercise_name, body.sets, reps, wkg, wlbs, body.comment
    )
    return {"ok": True}


@app.delete("/api/exercises/{exercise_id}")
def delete_exercise(exercise_id: int):
    db.delete_workout_exercise(exercise_id)
    return {"ok": True}


@app.put("/api/workouts/{session_id}/exercises/reorder")
def reorder_exercises(session_id: int, body: ReorderIn):
    db.reorder_workout_exercises(session_id, body.ids)
    return {"ok": True}


# ── Meal endpoints ─────────────────────────────────────────────────────────

@app.get("/api/meals")
def get_meals():
    return db.get_all_meal_sessions_full()


@app.post("/api/meals", status_code=201)
def create_meal(body: MealSessionIn):
    session_id = db.insert_meal_session_ui(body.date, body.meal_name, body.comment)
    return {"id": session_id}


@app.put("/api/meals/reorder")
def reorder_meals(body: ReorderIn):
    db.reorder_meal_sessions(body.ids)
    return {"ok": True}


@app.put("/api/meals/{session_id}")
def update_meal(session_id: int, body: MealSessionIn):
    db.update_meal_session(session_id, body.date, body.meal_name, body.comment)
    return {"ok": True}


@app.delete("/api/meals/{session_id}")
def delete_meal(session_id: int):
    db.delete_meal_session(session_id)
    return {"ok": True}


@app.post("/api/meals/{session_id}/items", status_code=201)
def add_meal_item(session_id: int, body: MealItemIn):
    item_id = db.insert_meal_item(
        session_id, body.food_name, body.amount_grams,
        body.kcal, body.protein_g, body.carbs_g, body.fat_g,
        body.is_estimated, None, body.comment, body.skip_food_db,
        body.amount_units, body.unit_name,
    )
    return {"id": item_id}


@app.put("/api/meal-items/{item_id}")
def update_meal_item(item_id: int, body: MealItemIn):
    db.update_meal_item(
        item_id, body.food_name, body.amount_grams,
        body.kcal, body.protein_g, body.carbs_g, body.fat_g,
        body.is_estimated, body.comment, body.skip_food_db,
        body.amount_units, body.unit_name,
    )
    return {"ok": True}


@app.delete("/api/meal-items/{item_id}")
def delete_meal_item(item_id: int):
    db.delete_meal_item(item_id)
    return {"ok": True}


# ── Foods DB endpoints ────────────────────────────────────────────────────

class FoodIn(BaseModel):
    name: str
    kcal_per_100g: float
    protein_per_100g: float
    carbs_per_100g: float
    fat_per_100g: float
    unit_name: str | None = None        # optional serving unit, e.g. 'Stk.'
    unit_grams: float | None = None     # grams per serving unit
    category: str = "standard"          # 'standard' | 'kalorien' | 'protein' | 'nebenbei'


@app.get("/api/foods")
def get_foods():
    return db.get_all_foods()


@app.post("/api/foods", status_code=201)
def create_food(body: FoodIn):
    food_id = db.upsert_food(body.name, body.kcal_per_100g, body.protein_per_100g,
                             body.carbs_per_100g, body.fat_per_100g,
                             body.unit_name, body.unit_grams, body.category)
    return {"id": food_id}


@app.put("/api/foods/{food_id}")
def update_food(food_id: int, body: FoodIn):
    db.update_food(food_id, body.name, body.kcal_per_100g, body.protein_per_100g,
                   body.carbs_per_100g, body.fat_per_100g,
                   body.unit_name, body.unit_grams, body.category)
    return {"ok": True}


# ── Settings (daily targets etc.) ──────────────────────────────────────────

class SettingsIn(BaseModel):
    kcal_target: str | None = None      # daily calorie limit
    protein_target: str | None = None   # daily protein goal (g)
    sync_dir: str | None = None         # shared folder for catalog sync (e.g. OneDrive)

@app.get("/api/settings")
def get_settings():
    return db.get_settings()

@app.put("/api/settings")
def put_settings(body: SettingsIn):
    # exclude_unset: only touch keys the caller actually sent — the targets
    # dialog must not wipe sync_dir and vice versa
    db.set_settings(body.model_dump(exclude_unset=True))
    return {"ok": True}


# ── Catalog sync via shared folder (e.g. OneDrive) ─────────────────────────
# Each machine writes fitrack-catalogs-<host>.json into the shared folder and
# merges every other machine's file. Foods, recipes and exercises are shared;
# diaries (workouts, meals, body data) stay local.

def _sync_host() -> str:
    import platform, re
    return re.sub(r"[^A-Za-z0-9_-]", "_", platform.node() or "local")

def _sync_dir() -> Path | None:
    raw = db.get_settings().get("sync_dir")
    return Path(raw) if raw else None

@app.get("/api/sync/status")
def sync_status():
    d = _sync_dir()
    peers = []
    if d and d.is_dir():
        own = f"fitrack-catalogs-{_sync_host()}.json"
        peers = [f.name for f in d.glob("fitrack-catalogs-*.json") if f.name != own]
    return {
        "sync_dir":   str(d) if d else None,
        "dir_exists": bool(d and d.is_dir()),
        "host":       _sync_host(),
        "peer_files": peers,
    }

@app.post("/api/sync/run")
def sync_run():
    import json
    d = _sync_dir()
    if d is None:
        return {"ok": False, "error": "Kein Sync-Ordner konfiguriert."}
    if not d.is_dir():
        return {"ok": False, "error": f"Ordner nicht gefunden: {d}"}

    own_name = f"fitrack-catalogs-{_sync_host()}.json"
    added = {"foods": 0, "recipes": 0, "exercises": 0}
    peers = []
    for f in sorted(d.glob("fitrack-catalogs-*.json")):
        if f.name == own_name:
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue          # unreadable peer file — skip, never abort the sync
        c = db.merge_catalogs(data)
        for k in added:
            added[k] += c[k]
        peers.append(f.name)

    # Write own export AFTER merging so it already contains everything
    (d / own_name).write_text(
        json.dumps(db.get_catalogs_export(), ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return {"ok": True, "added": added, "peers": peers, "own_file": own_name}


@app.delete("/api/foods/{food_id}")
def delete_food(food_id: int):
    db.delete_food(food_id)
    return {"ok": True}


# ── Exercise catalog endpoints ─────────────────────────────────────────────

class ExerciseCatalogIn(BaseModel):
    name: str
    comment: str | None = None

@app.get("/api/exercise-catalog")
def get_exercise_catalog():
    return db.get_all_exercises()

@app.post("/api/exercise-catalog", status_code=201)
def create_exercise_catalog(body: ExerciseCatalogIn):
    return {"id": db.upsert_exercise(body.name, body.comment)}

@app.put("/api/exercise-catalog/{exercise_id}")
def update_exercise_catalog(exercise_id: int, body: ExerciseCatalogIn):
    db.update_exercise_catalog(exercise_id, body.name, body.comment)
    return {"ok": True}

@app.delete("/api/exercise-catalog/{exercise_id}")
def delete_exercise_catalog(exercise_id: int):
    db.delete_exercise_catalog(exercise_id)
    return {"ok": True}


# ── Endurance endpoints ────────────────────────────────────────────────────

@app.get("/api/endurance")
def get_endurance():
    return db.get_all_endurance_sessions()


@app.post("/api/endurance", status_code=201)
def create_endurance(body: EnduranceSessionIn):
    sid = db.insert_endurance_session(
        body.date, body.activity_type, body.distance_km, body.duration_s,
        body.elevation_m, body.avg_hr, body.kcal, body.comment,
    )
    return {"id": sid}


@app.put("/api/endurance/reorder")
def reorder_endurance(body: ReorderIn):
    db.reorder_endurance_sessions(body.ids)
    return {"ok": True}


@app.put("/api/endurance/{session_id}")
def update_endurance(session_id: int, body: EnduranceSessionIn):
    db.update_endurance_session(
        session_id, body.date, body.activity_type, body.distance_km, body.duration_s,
        body.elevation_m, body.avg_hr, body.kcal, body.comment,
    )
    return {"ok": True}


@app.delete("/api/endurance/{session_id}")
def delete_endurance(session_id: int):
    db.delete_endurance_session(session_id)
    return {"ok": True}


# ── Sport endpoints ────────────────────────────────────────────────────────

@app.get("/api/sports")
def get_sports():
    return db.get_all_sport_sessions()


@app.post("/api/sports", status_code=201)
def create_sport(body: SportSessionIn):
    sid = db.insert_sport_session(
        body.date, body.sport_name, body.duration_s,
        body.avg_hr, body.kcal, body.comment,
    )
    return {"id": sid}


@app.put("/api/sports/reorder")
def reorder_sports(body: ReorderIn):
    db.reorder_sport_sessions(body.ids)
    return {"ok": True}


@app.put("/api/sports/{session_id}")
def update_sport(session_id: int, body: SportSessionIn):
    db.update_sport_session(
        session_id, body.date, body.sport_name, body.duration_s,
        body.avg_hr, body.kcal, body.comment,
    )
    return {"ok": True}


@app.delete("/api/sports/{session_id}")
def delete_sport(session_id: int):
    db.delete_sport_session(session_id)
    return {"ok": True}


# ── Recipes ────────────────────────────────────────────────────────────────

class RecipeItemIn(BaseModel):
    food_name: str
    amount_grams: float

class RecipeIn(BaseModel):
    name: str
    items: list[RecipeItemIn] = []

@app.get("/api/recipes")
def get_recipes():
    return db.get_all_recipes()

@app.post("/api/recipes", status_code=201)
def create_recipe(body: RecipeIn):
    rid = db.upsert_recipe(None, body.name, [i.model_dump() for i in body.items])
    return {"id": rid}

@app.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, body: RecipeIn):
    db.upsert_recipe(recipe_id, body.name, [i.model_dump() for i in body.items])
    return {"ok": True}

@app.delete("/api/recipes/{recipe_id}")
def delete_recipe(recipe_id: int):
    db.delete_recipe(recipe_id)
    return {"ok": True}


# ── Body tracking ──────────────────────────────────────────────────────────

class BodyWeightIn(BaseModel):
    date: str
    weight_kg: float
    comment: str | None = None

class BodyMeasurementIn(BaseModel):
    date: str
    name: str
    value: float
    unit: str = "cm"

class BodyPhotoIn(BaseModel):
    date: str
    filename: str
    data_b64: str          # base64-encoded image payload
    comment: str | None = None

@app.get("/api/body/weight")
def get_body_weight():
    return db.get_all_body_weight()

@app.post("/api/body/weight", status_code=201)
def create_body_weight(body: BodyWeightIn):
    return {"id": db.insert_body_weight(body.date, body.weight_kg, body.comment)}

@app.put("/api/body/weight/{entry_id}")
def update_body_weight(entry_id: int, body: BodyWeightIn):
    db.update_body_weight(entry_id, body.date, body.weight_kg, body.comment)
    return {"ok": True}

@app.delete("/api/body/weight/{entry_id}")
def delete_body_weight(entry_id: int):
    db.delete_body_weight(entry_id)
    return {"ok": True}

@app.get("/api/body/measurements")
def get_body_measurements():
    return db.get_all_body_measurements()

@app.post("/api/body/measurements", status_code=201)
def create_body_measurement(body: BodyMeasurementIn):
    return {"id": db.insert_body_measurement(body.date, body.name, body.value, body.unit)}

@app.put("/api/body/measurements/{entry_id}")
def update_body_measurement(entry_id: int, body: BodyMeasurementIn):
    db.update_body_measurement(entry_id, body.date, body.name, body.value, body.unit)
    return {"ok": True}

@app.delete("/api/body/measurements/{entry_id}")
def delete_body_measurement(entry_id: int):
    db.delete_body_measurement(entry_id)
    return {"ok": True}

@app.get("/api/body/photos")
def get_body_photos():
    return db.get_all_body_photos()

@app.post("/api/body/photos", status_code=201)
def create_body_photo(body: BodyPhotoIn):
    import base64
    import re
    import time

    ext = Path(body.filename).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
        raise HTTPException(status_code=400, detail=f"Nicht unterstütztes Bildformat: {ext}")
    # Server-generated name: date + timestamp; never trust the client filename.
    safe_date = re.sub(r"[^0-9-]", "", body.date)
    fname = f"{safe_date}_{int(time.time() * 1000)}{ext}"
    try:
        raw = base64.b64decode(body.data_b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Ungültige Bilddaten (base64).")
    (UPLOADS / fname).write_bytes(raw)
    photo_id = db.insert_body_photo(body.date, fname, body.comment)
    return {"id": photo_id, "filename": fname}

@app.delete("/api/body/photos/{photo_id}")
def delete_body_photo(photo_id: int):
    fname = db.delete_body_photo(photo_id)
    if fname:
        f = UPLOADS / Path(fname).name   # basename only — no path traversal
        if f.exists():
            f.unlink()
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
