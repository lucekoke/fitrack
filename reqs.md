# fitrack – Anforderungsspezifikation

> **Stand 2026-07-14:** Die Telegram-/Claude-Pipeline (Freitext-Eingabe per Bot,
> KI-Extraktion) wurde **vollständig entfernt** — inklusive `telegram_client.py`,
> `main.py`, `claude_processor.py`, dem Sync-Tab und aller zugehörigen Endpunkte
> und Konfiguration. fitrack ist jetzt eine rein lokale Web-App (FastAPI + SQLite
> + Vanilla-JS-Frontend). Neu hinzugekommen: **Körper-Tracking** (Gewicht, Maße,
> Fortschrittsfotos per Drag&Drop) und ein **Analyse-Tab** (Zeit-Gewichts-Diagramme).

## 1. Projektkontext

Persönliches Tracking-System für Workouts und Ernährung. Ein lokaler FastAPI-Server
(`server.py`, gestartet via `uvicorn server:app --reload --port 8000`) stellt unter
`http://localhost:8000` eine Single-Page-Web-App bereit. Alle Daten (Workouts,
Ausdauer, Sport, Mahlzeiten, Lebensmittel, Rezepte, Übungen, Körperdaten) werden
direkt in der UI angelegt, bearbeitet, sortiert, kopiert und gelöscht und in einer
lokalen SQLite-Datenbank (`fitrack.db`, WAL-Modus) gespeichert.

Das System bleibt rein lokal, Single-User, ohne Authentifizierung und ohne
Always-On-Betrieb. Coaching-Gespräche und tiefergehende Auswertungen finden
außerhalb in Claude.ai statt (CSV-Export als Brücke).

## 2. Glossar

- **Workout-Eintrag:** Eine Übung (`workout_exercises`) mit Sätzen/Reps/Gewicht
  innerhalb einer Trainingseinheit (`workout_sessions`).
- **Ausdauer-Eintrag:** Ein Lauf oder eine Radfahrt (`endurance_sessions`) mit
  Distanz, Dauer, Höhenmetern, Herzfrequenz, Kalorien.
- **Sport-Eintrag:** Eine Hobby-/Team-Sport-Einheit (`sport_sessions`).
- **Meal-Item:** Eine konsumierte Zutat (`meal_items`) mit Menge und Makros,
  Teil einer Mahlzeit (`meal_sessions`).
- **Lebensmittel-Stammdatum:** Datensatz in `foods` mit Makros pro 100 g.
- **Rezept:** Benannte, wiederverwendbare Zutaten-Kombination (`recipes` +
  `recipe_items`), beim Mahlzeit-Anlegen anteilig übernehmbar.
- **Übungs-Stammdatum:** Datensatz in `exercise_catalog` (eindeutiger Name +
  optionaler Kommentar, z. B. YouTube-Link).
- **Körperdaten:** Gewichts-Einträge (`body_weight`), Maße (`body_measurements`),
  Fortschrittsfotos (`body_photos` + Dateien unter `uploads/`).

## 3. Funktionale Anforderungen

### 3.1 Server & Frontend-Grundgerüst

**FR-1.1** Lokaler FastAPI-Server (`server.py`); Frontend als Single-Page-App
(`static/index.html`, `static/app.js`, `static/style.css`), Pico CSS v2
(Light-Theme), Vanilla-JS, kein Build-Schritt.

**FR-1.2** Haupt-Tabs: **Aktivitäten**, **Mahlzeiten**, **Körper**, **Analyse**,
**AI Coach** (Platzhalter).

**FR-1.3** Der Server MUSS Caching unterbinden (`Cache-Control: no-cache`);
das Frontend nutzt zusätzlich Cache-Busting (`app.js?v=N`, bei jeder
Frontend-Änderung erhöhen).

**FR-1.4** Reihenfolge-kritische Routen (`…/reorder`) MÜSSEN vor den
parametrisierten Routen (`…/{id}`) registriert werden.

**FR-1.5** Modal-Dialoge: zwei `<dialog>`-Elemente (`#modal` für Editoren,
`#modal2` für Picker, die ÜBER einem Editor geöffnet werden — z. B. Rezept-Wahl).
Beim Öffnen MUSS das erste Eingabefeld fokussiert, beim Schließen der Inhalt
geleert werden (verhindert Focus-Trap-/Duplicate-ID-Probleme, bei denen
Tastatureingaben verloren gehen).

### 3.2 Aktivitäten

**FR-2.1** Kombinierte Verlaufsansicht: Kraft-, Ausdauer- (`run`/`ride`) und
Sport-Einträge gemeinsam, nach Datum absteigend, mit Typ-Badges.

**FR-2.2** Kraft-Workouts: Sessions (Datum, Kommentar) mit Übungen darunter
(Name, Sätze, Reps je Satz, Gewicht je Satz in kg UND lbs). Gewichts-Eingabe als
Freitext (`100` oder `100,102.5,105`) + Einheiten-Dropdown; der Server rechnet in
beide Einheiten um (Faktor 2.20462, 1 Nachkommastelle). Bodyweight = leeres Feld.

**FR-2.3** Umsortieren von Übungen (▲/▼, `sort_order`), Kopieren ganzer Workouts
auf ein anderes Datum und einzelner Übungen in eine andere Session. Beim Kopieren
MUSS die ursprüngliche Eingabe-Einheit erhalten bleiben (Heuristik
`pick_weight_unit`: welcher gespeicherte Wert „glatter" ist) — niemals pauschal
kg annehmen und lbs neu ableiten.

**FR-2.4** Übungs-Eingabe mit Autocomplete (`<datalist>`) aus dem Übungs-Katalog.

**FR-2.5** Unter-Tab **Übungen**: Katalog-Verwaltung (`exercise_catalog`) mit
Kommentarfeld (URLs als klickbare Links gerendert). Auto-Pflege: Übungsnamen aus
Workouts werden automatisch registriert (case-insensitiv eindeutig), vorhandene
Kommentare dabei NIE überschrieben. Umbenennung propagiert auf alle
`workout_exercises`.

**FR-2.6** CSV-Export der Workout-Historie (Header-Button): gesamte Historie oder
Von/Bis-Zeitraum; eine Zeile pro Übung (Datum, Session-Kommentar, Übung, Sätze,
Reps, Gewicht kg, Gewicht lbs, Kommentar); UTF-8 mit BOM; Bodyweight als „BW".

### 3.3 Mahlzeiten

**FR-3.1** Unter-Tabs: **Tagebuch**, **Lebensmittel**, **Rezepte**. Der
„+ Neue Mahlzeit"-Button ist nur im Tagebuch sichtbar.

**FR-3.2** Tagebuch: Mahlzeiten pro Tag gruppiert mit Tages-Makrosummen;
Umsortieren innerhalb des Tages; Kopieren auf anderes Datum; Editor mit
Zutaten-Zeilen (Lebensmittel-Autocomplete, Menge, Makros).

**FR-3.3** Makro-Felder sind **read-only** (✓-Badge), wenn die Zutat einem
`foods`-Stammdatum entspricht; Mengenänderung rechnet live aus den
je-100g-Werten. Unbekannte Zutaten: Badge „neu", Felder editierbar.

**FR-3.4** Auto-Registrierung: Beim Speichern eines Items mit Menge+Makros wird
ein unbekanntes Lebensmittel automatisch in `foods` angelegt (hochgerechnet auf
100 g) — AUSSER das Item ist als **einmalig** markiert (`skip_food_db`, Badge
„einmalig"). Einmalig-Semantik bleibt bei Bearbeiten und Kopieren erhalten
(Items ohne `foods`-Treffer werden beim Kopieren mit `skip_food_db=true`
übertragen).

**FR-3.5** Lebensmittel-Verwaltung: CRUD über `foods`; Eingabe der Nährwerte
wahlweise „je X g" (Speicherung immer pro 100 g); Änderungen propagieren auf
alle `meal_items` (Umbenennung + Makro-Neuberechnung aus `amount_grams`).

**FR-3.6** Rezepte: benannte Zutaten-Listen mit Mengen; Anzeige der
Gesamt-Makros (aus `foods` berechnet). Im Mahlzeit-Editor fügt „+ Rezept"
(Picker im zweiten Modal) die Zutaten anteilig skaliert
(`Portion / Rezept-Gesamtgewicht`) als normale Zeilen ein.

**FR-3.7** Zutaten-Import aus bestehender Mahlzeit mit Faktor (`1/5`, `0.2`).

### 3.4 Körper

**FR-4.1** Körpergewicht: Liste (Datum, kg, Kommentar) mit CRUD
(`body_weight`, `/api/body/weight`).

**FR-4.2** Körpermaße: generische Einträge (Datum, Name, Wert, Einheit cm/%/mm)
mit CRUD (`body_measurements`); Namens-Vorschläge per `<datalist>`
(Brust, Taille, Bizeps, …).

**FR-4.3** Fortschrittsfotos: Upload per **Drag&Drop** oder Datei-Dialog
(mehrere gleichzeitig); Anzeige als Galerie-Grid (Datum + Löschen; Klick öffnet
Vollbild). Übertragung als base64-JSON (kein zusätzliches
`python-multipart`-Paket); Speicherung als Datei unter `uploads/`
(server-generierter Dateiname `datum_timestamp.ext`, Whitelist
jpg/jpeg/png/gif/webp, Client-Dateiname wird nie übernommen) + DB-Zeile
(`body_photos`). Löschen entfernt Datei UND DB-Zeile. `uploads/` wird als
statisches Verzeichnis gemountet.

### 3.5 Analyse

**FR-5.1** X-Y-Diagramm: x = Zeit, y = Gewicht. Datenreihen-Auswahl per
Dropdown: **Körpergewicht** oder jede Übung mit mindestens einem Gewichtssatz
(y = Top-Satz-Gewicht in kg je Datum, Maximum bei mehreren Sessions am selben Tag).

**FR-5.2** Darstellung: **gepunktete Linie** (2px, runde Kappen) **mit Punkten
an jedem vorhandenen Datum** (r ≥ 4, 2px Ring in Oberflächenfarbe); handgerolltes
SVG ohne externe Chart-Bibliothek; dezente horizontale Gridlines mit „glatten"
Y-Ticks (1/2/5 × 10ⁿ); Datums-Labels auf max. ~6 Datenpunkte verteilt;
Endpunkt direkt beschriftet.

**FR-5.3** Hover-Layer: vertikaler Crosshair rastet auf den nächsten Datenpunkt;
Tooltip zeigt Wert (fett) + Datum; Werte sind zusätzlich ohne Hover über eine
ausklappbare **Datentabelle** erreichbar. Leere Auswahl zeigt eine
Leer-Nachricht.

### 3.6 Datenbank

SQLite (WAL), Schema wird beim Start automatisch erstellt; Erweiterungen über
idempotente Migrationen (`CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info` +
`ALTER TABLE`). Tabellen:

- `workout_sessions` (id, telegram_message_id UNIQUE — Legacy, für UI-Einträge
  negativ generiert —, date, comment, created_at)
- `workout_exercises` (id, session_id FK, exercise_name, sets, reps_per_set
  JSON, weight_kg JSON|null, weight_lbs JSON|null, comment, sort_order, created_at)
- `meal_sessions` (id, telegram_message_id — Legacy —, date, meal_name, comment,
  sort_order, created_at)
- `meal_items` (id, session_id FK, food_name, amount_grams, kcal, protein_g,
  carbs_g, fat_g, is_estimated, food_id FK|null, comment, created_at)
- `foods` (id, name UNIQUE — Title-Case gespeichert, case-insensitiv gesucht —,
  kcal/protein/carbs/fat_per_100g, created_at, last_used_at)
- `endurance_sessions` (id, date, activity_type CHECK run|ride, distance_km,
  duration_s, elevation_m, avg_hr, kcal, comment, sort_order, …)
- `sport_sessions` (id, date, sport_name, duration_s, avg_hr, kcal, comment,
  sort_order, …)
- `recipes` (id, name UNIQUE) / `recipe_items` (id, recipe_id FK CASCADE,
  food_name, amount_grams, sort_order)
- `exercise_catalog` (id, name UNIQUE COLLATE NOCASE, comment, created_at,
  last_used_at)
- `body_weight` (id, date, weight_kg, comment)
- `body_measurements` (id, date, name, value, unit)
- `body_photos` (id, date, filename, comment, created_at)
- `processing_log`, `pending_clarifications`: Legacy-Tabellen der entfernten
  Telegram-Pipeline; bleiben bestehen (historische Daten), werden nicht mehr
  beschrieben.

### 3.7 REST-API (vollständiges CRUD)

- Workouts: `GET/POST /api/workouts`, `PUT/DELETE /api/workouts/{id}`,
  `POST /api/workouts/{id}/exercises`, `PUT/DELETE /api/exercises/{id}`,
  `PUT /api/workouts/{id}/exercises/reorder`
- Mahlzeiten: `GET/POST /api/meals`, `PUT /api/meals/reorder`,
  `PUT/DELETE /api/meals/{id}`, `POST /api/meals/{id}/items`,
  `PUT/DELETE /api/meal-items/{id}`
- Lebensmittel: `GET/POST /api/foods`, `PUT/DELETE /api/foods/{id}`
- Ausdauer/Sport: analog mit `/reorder`
- Rezepte: `GET/POST /api/recipes`, `PUT/DELETE /api/recipes/{id}`
- Übungs-Katalog: `GET/POST /api/exercise-catalog`,
  `PUT/DELETE /api/exercise-catalog/{id}`
- Körper: `GET/POST /api/body/weight|measurements`, `PUT/DELETE …/{id}`,
  `GET/POST /api/body/photos`, `DELETE /api/body/photos/{id}`

## 4. Nicht-funktionale Anforderungen

**NFR-1** (Plattform) Windows, Python 3.11+ (aktuell 3.13), venv unter `venv/`.

**NFR-2** (Abhängigkeiten) `requirements.txt`: `python-dotenv`, `fastapi`,
`uvicorn`. SQLite via Standard-Library. Frontend ohne Build-Tooling und ohne
Chart-/JS-Bibliotheken (Pico CSS via CDN ist die einzige externe Ressource).

**NFR-3** (Konfiguration) `.env` optional; einziger Wert: `DB_PATH`
(Default `fitrack.db`).

**NFR-4** (Code-Struktur) Module: `server.py` (FastAPI + Endpunkte),
`database.py` (Schema, Migrationen, Queries), `config.py` (`.env`),
`static/` (Frontend).

**NFR-5** (Sicherheit, lokal) Keine Auth (nur localhost); Uploads:
Extensions-Whitelist, server-generierte Dateinamen, kein Path-Traversal
(basename-only beim Löschen). Nutzereingaben im Frontend werden escaped
(`esc()`), Tooltip-Inhalte via `textContent`.

## 5. Bewusste Nicht-Anforderungen

- Keine Telegram-/KI-Eingabe mehr (Pipeline entfernt; Historie bleibt in der DB)
- Keine Mahlzeit-Labels (Frühstück/Mittag/Abend), keine Mikronährstoffe
- Keine Multi-User-Unterstützung, keine Authentifizierung
- Keine automatischen Backups (Nutzer sichert `fitrack.db` + `uploads/` selbst)
- Kein Cloud-Hosting, kein Always-On-Betrieb

## 6. Backlog

- **AI-Coach-Tab** (aktuell leer)
- Analyse: weitere Metriken (Volumen je Muskelgruppe, Reps-Progression,
  Körpermaße als Datenreihe, Kalorien-/Makro-Trends aus dem Tagebuch)
- Mehrere Datenreihen im selben Diagramm (dann Legende + validierte
  Kategorial-Palette)
- Fotos: Datum beim Upload wählbar/editierbar, Kommentar, Vergleichsansicht
- DB-Export für Claude.ai-Coaching (über CSV-Export hinaus)

## 7. Phasen-Historie

1. **Telegram-Bot + Claude-Extraktion** (Phasen 1–5, entfernt 2026-07-14)
2. **Web-UI**: FastAPI + CRUD für alle Datenarten ✅
3. **Erweiterungen**: Ausdauer/Sport, Rezepte, Übungs-Katalog,
   Komfortfunktionen, CSV-Export ✅
4. **Körper + Analyse**: Body-Tracking, Foto-Upload, SVG-Diagramme ✅
5. **AI Coach**: offen
