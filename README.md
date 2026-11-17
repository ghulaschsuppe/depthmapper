# DepthMapper

Depthmaps (Graustufen-Tiefenbilder) für die 3D-Lasergravur direkt im Browser erzeugen –
z. B. für Messing-Münzen mit dem xTool F2 Ultra.

- **3D-Modell → Depthmap:** STL, OBJ, PLY, 3MF, GLB/GLTF laden, frei ausrichten, Tiefe und Graustufen einstellen,
  positiv (erhaben) oder invertiert (eingeprägt).
- **Bild → Relief:** Aus Fotos, Logos und Zeichnungen ein Relief mit Wölbung und Detailbetonung erzeugen.
- 3D-Gravurvorschau auf Messing, Holz, Edelstahl & Co.
- Export als PNG mit transparentem Hintergrund und korrekter DPI-Angabe.

Alles läuft lokal im Browser – keine Uploads, kein Server-Code, keine Datenbank.

## Starten
Den Ordner auf einen beliebigen Webspace legen oder lokal mit `python3 -m http.server` bzw. `php -S localhost:8000` starten.

Details: siehe [PROJEKT.md](PROJEKT.md). Three.js steht unter MIT-Lizenz (`vendor/three/LICENSE`).
