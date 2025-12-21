# KLV Display — STANAG 4609 Metadata Viewer

## Contexte

Projet demo/POC pour une mission freelance défense :
- Parsing de flux vidéo drone avec métadonnées STANAG 4609
- Affichage temps réel vidéo + carte + infos capteur
- Historique des positions et replay

## Objectif

Créer une application web qui :
1. Reçoit un flux MPEG-2 TS contenant vidéo + métadonnées KLV
2. Affiche la vidéo en temps réel
3. Affiche une carte avec position GPS synchronisée
4. Affiche les infos capteur (FOV, tilt, pan, altitude)
5. Enregistre l'historique des positions
6. Permet le replay avec timeline

## Architecture technique

```
Input: MPEG-2 TS (.ts file ou UDP stream)
         │
         ▼
┌─────────────────────────────┐
│  Node.js Backend            │
│  ├── FFmpeg (demux TS)      │
│  │   ├── Video → HLS/WebRTC │
│  │   └── Data PID → KLV     │
│  ├── KLV Parser             │
│  └── WebSocket server       │
└─────────────────────────────┘
         │
         ▼ WebSocket (metadata JSON)
         ▼ HLS/WebRTC (video)
┌─────────────────────────────┐
│  React Frontend             │
│  ├── Video.js (player)      │
│  ├── Leaflet (map + trace)  │
│  ├── Info panel (sensor)    │
│  └── Timeline (replay)      │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  PostgreSQL + PostGIS       │
│  (historique positions)     │
└─────────────────────────────┘
```

## STANAG 4609 / KLV — Détails techniques

### Structure du TS

```
MPEG-2 Transport Stream
├── PID video (H.264/MPEG-2)
├── PID audio (optionnel)
└── PID data (KLV metadata)
```

### Structure KLV (Key-Length-Value)

```
┌─────────────────┬─────────────────┬─────────────────┐
│      KEY        │     LENGTH      │      VALUE      │
│   (16 bytes)    │   (1-4 bytes)   │   (variable)    │
└─────────────────┴─────────────────┴─────────────────┘
```

- **Key** : UUID 16 octets (ex: UAS Local Set = 06 0E 2B 34 02 0B 01 01 0E 01 03 01 01 00 00 00)
- **Length** : Encodage BER
- **Value** : Données ou nested KLV

### Tags MISB 0601 importants

| Tag | Nom | Type | Description |
|-----|-----|------|-------------|
| 2 | Precision Timestamp | uint64 | Microseconds since epoch |
| 5 | Platform Heading | uint16 | 0-360° |
| 13 | Sensor Latitude | int32 | WGS84 |
| 14 | Sensor Longitude | int32 | WGS84 |
| 15 | Sensor Altitude | uint16 | Meters |
| 16 | Sensor HFOV | uint16 | Horizontal FOV |
| 17 | Sensor VFOV | uint16 | Vertical FOV |
| 18 | Sensor Relative Azimuth | uint32 | Pan angle |
| 19 | Sensor Relative Elevation | int32 | Tilt angle |
| 23 | Frame Center Latitude | int32 | Target position |
| 24 | Frame Center Longitude | int32 | Target position |
| 25 | Frame Center Elevation | uint16 | Target altitude |

### Encodage BER Length

```
< 128      → 1 byte direct
128-255    → 0x81 + 1 byte
256-65535  → 0x82 + 2 bytes
```

## Ressources pour tester

### Fichiers samples

```
https://github.com/paretech/klvdata/tree/master/data
https://samples.ffmpeg.org/ (chercher "klv")
https://github.com/SenSaaSS/MISB-KLV-generator
```

### Commandes FFmpeg utiles

```bash
# Voir les streams dans un TS
ffprobe -show_streams input.ts

# Extraire le PID data (KLV)
ffmpeg -i input.ts -map 0:d -c copy metadata.bin

# Voir les metadata brutes
ffprobe -show_data -select_streams d:0 input.ts

# Demux video + data séparément
ffmpeg -i input.ts -map 0:v -c copy video.h264 -map 0:d -c copy klv.bin
```

### GStreamer

```bash
# Avec plugin klvmeta
gst-launch-1.0 filesrc location=input.ts ! tsdemux ! klvparse ! fakesink dump=true
```

## Stack suggérée

### Backend (Node.js)

```json
{
  "dependencies": {
    "express": "^4.18",
    "ws": "^8.14",
    "fluent-ffmpeg": "^2.1",
    "pg": "^8.11"
  }
}
```

### Frontend (React)

```json
{
  "dependencies": {
    "react": "^18",
    "video.js": "^8",
    "leaflet": "^1.9",
    "react-leaflet": "^4",
    "socket.io-client": "^4"
  }
}
```

### Base de données

```sql
CREATE EXTENSION postgis;

CREATE TABLE positions (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  location GEOGRAPHY(POINT, 4326),
  altitude REAL,
  heading REAL,
  sensor_tilt REAL,
  sensor_pan REAL,
  fov_h REAL,
  fov_v REAL,
  metadata JSONB
);

CREATE INDEX idx_positions_time ON positions(timestamp);
CREATE INDEX idx_positions_geo ON positions USING GIST(location);
```

## UI Mockup

```
┌─────────────────────────────────────────────────────────┐
│  STANAG 4609 Viewer                          [REC ●]   │
├──────────────────────────┬──────────────────────────────┤
│                          │  📍 Position                 │
│                          │  Lat: 48.8566° N             │
│     VIDEO FEED           │  Lon: 2.3522° E              │
│                          │  Alt: 152m AGL               │
│     [advancement bar]    │                              │
│                          │  📷 Sensor                   │
├──────────────────────────┤  FOV: 24.5°                  │
│                          │  Tilt: -32°                  │
│     MAP (Leaflet)        │  Pan: 187°                   │
│        📍──📍──📍        │                              │
│     (trace historique)   │  ⏱ 14:23:07.234 UTC         │
│                          │                              │
└──────────────────────────┴──────────────────────────────┘
│◀◀  ◀  ▶  ▶▶│ ████████░░░░░░░░ │ Replay timeline        │
└─────────────────────────────────────────────────────────┘
```

## Features prioritaires

### MVP (Phase 1)
- [ ] Parser KLV basique (tags géo essentiels)
- [ ] Affichage vidéo depuis fichier .ts
- [ ] Carte Leaflet avec position
- [ ] Panel infos capteur

### Phase 2
- [ ] WebSocket temps réel
- [ ] Trace historique sur carte
- [ ] Stockage PostgreSQL
- [ ] Timeline replay

### Phase 3 (bonus)
- [ ] Click-to-coords (clic vidéo → GPS)
- [ ] Export KML/GeoJSON
- [ ] Geofencing alerts
- [ ] Multi-source

## Références

- MISB ST 0601 (UAS Datalink Local Set) : https://nsgreg.nga.mil/misb.jsp
- KLV Encoding : SMPTE 336M
- Lib Python : https://github.com/paretech/klvdata
- GStreamer KLV : https://gstreamer.freedesktop.org/documentation/klv/

## Contact

Projet perso de Stéphane Bhiri pour démonstration compétences STANAG 4609.
