# fitrack – Gym-Buddy & Nutrition-Tracker

Persoenliches Tracking-System fuer Workouts, Ernaehrung und Koerperdaten als
lokale Web-App: FastAPI-Server + SQLite-Datenbank + Vanilla-JS-Frontend.

> Die fruehere Telegram-/Claude-Pipeline (Freitext-Eingabe per Bot) wurde
> entfernt. Alle Eingaben laufen ueber die Web-UI.

---

## Voraussetzungen

- Python 3.11+ (Windows)

## Setup (einmalig)

```powershell
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

Optional: `.env` mit `DB_PATH=...` (Default: `fitrack.db` im Projektordner).

## Starten

```powershell
venv\Scripts\python -m uvicorn server:app --reload --port 8000
```

Dann im Browser: <http://localhost:8000>

Beim ersten Start werden `fitrack.db` (Schema inkl. Migrationen) und `uploads/`
(Fortschrittsfotos) automatisch angelegt.

---

## Funktionen

| Tab | Inhalt |
|---|---|
| **Aktivitaeten** | Kraft-Workouts (Saetze/Reps/Gewicht in kg+lbs), Laeufe, Radfahrten, Hobby-Sport. Umsortieren, Kopieren (Workout/Uebung, Einheit bleibt erhalten), CSV-Export (alles oder Zeitraum). Unter-Tab **Uebungen**: Uebungs-Datenbank mit Kommentaren (z. B. YouTube-Links, klickbar). |
| **Mahlzeiten** | Tagebuch mit Tages-Makrosummen; Zutaten mit Autocomplete aus der Lebensmittel-DB (Makros read-only bei Treffer, live-Umrechnung bei Mengenaenderung); einmalige Eintraege ohne DB-Aufnahme; Import aus bestehender Mahlzeit mit Faktor. Unter-Tabs **Lebensmittel** (Stammdaten je 100 g, Eingabe auch „je X g") und **Rezepte** (skalierte Uebernahme in Mahlzeiten). |
| **Koerper** | Koerpergewicht, Koerpermasse (cm/%/mm) und Fortschrittsfotos per Drag&Drop (gespeichert unter `uploads/`). |
| **Analyse** | Zeit-Diagramm (gepunktete Linie mit Punkten je Datum): Koerpergewicht oder Top-Satz-Gewicht jeder Uebung. Hover-Tooltip + Datentabelle. |
| **AI Coach** | Platzhalter. |

## Dateien & Struktur

```
fitrack/
+-- server.py          # FastAPI-App, alle /api-Endpunkte
+-- database.py        # SQLite-Schema, Migrationen, Queries
+-- config.py          # .env laden (DB_PATH)
+-- static/            # Frontend (index.html, app.js, style.css)
+-- requirements.txt
+-- fitrack.db         # SQLite-DB (automatisch erstellt)
+-- uploads/           # Fortschrittsfotos (automatisch erstellt)
```

## Backup

`fitrack.db` und `uploads/` sichern — mehr gibt es nicht.

## Anforderungen im Detail

Siehe [reqs.md](reqs.md).
