# fitrack

Persönlicher Workout- & Ernährungstracker als lokale Web-App:
FastAPI + SQLite + Vanilla-JS. Kein Cloud-Dienst, keine Accounts — alle Daten bleiben auf dem eigenen Rechner.

## Setup & Start

```powershell
python -m venv venv
venv\Scripts\pip install -r requirements.txt
venv\Scripts\python -m uvicorn server:app --port 8000
```

Dann im Browser: <http://localhost:8000>

Beim ersten Start werden `fitrack.db` und `uploads/` automatisch angelegt;
Schema-Updates laufen als automatische Migrationen, bestehende Daten bleiben erhalten.
Optional: `.env` mit `DB_PATH=…` (Default: `fitrack.db`).

## Funktionen

- **Aktivitäten** — Kraft-Workouts (Sätze/Reps/Gewicht in kg oder lbs), Läufe, Radfahrten, Schwimmen, Hobby-Sport; Umsortieren, Kopieren, CSV-Export. Unter-Tab **Übungen**: Übungsdatenbank mit Kommentaren (z. B. YouTube-Links).
- **Mahlzeiten** — Tagebuch mit Tages-Makrosummen und Soll/Ist-Bilanz (kcal-Limit, Protein-Ziel); Zutaten mit Autocomplete und automatischer Makro-Berechnung; Mengen in Gramm oder Einheiten (Stk., Scheibe, Handvoll, …); einmalige Einträge ohne DB-Aufnahme.
- **Lebensmittel** — Nährwerte je 100 g oder je Einheit; Kategorien: Standard, Kalorienfokus, Proteinquelle, Nebenbei (grobe Schätzung reicht).
- **Rezepte** — wiederverwendbare Zutatenkombinationen, portionsweise in Mahlzeiten übernehmbar; Zutaten direkt in der Übersicht aufklappbar.
- **Körper** — Gewicht, Maße und Fortschrittsfotos per Drag & Drop.
- **Analyse** — Verlaufsdiagramme (Stufenlinie mit Punkten je Datum): Übungsgewicht (Max und Ø über Sätze, in Original-Einheit) oder Körpergewicht.
- **Sync** — Lebensmittel, Rezepte und Übungen über einen gemeinsamen Ordner (z. B. OneDrive) mit anderen teilen; Tagebuch, Workouts und Körperdaten bleiben privat.

## Struktur

```
fitrack/
├── server.py        # FastAPI-App, alle /api-Endpunkte
├── database.py      # SQLite-Schema, Migrationen, Queries
├── config.py        # .env laden
├── static/          # Frontend (index.html, app.js, style.css)
├── fitrack.db       # Datenbank (automatisch erstellt, nicht in Git)
└── uploads/         # Fortschrittsfotos (automatisch erstellt, nicht in Git)
```

**Backup:** `fitrack.db` und `uploads/` kopieren — mehr gibt es nicht.
