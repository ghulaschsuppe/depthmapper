# DepthMapper – Projektübersicht

Web-App zum Erzeugen von **Depthmaps** (Graustufen-Tiefenbildern) für die 3D-/Relief-Lasergravur,
orientiert an den Werten des **xTool F2 Ultra** (Standard: 256 Graustufen, z. B. für Messing-Münzen).

## Funktionen

### Bereich 1 – 3D-Modell → Depthmap
- Laden von STL, OBJ, PLY, 3MF, GLB/GLTF (Drag & Drop, alles lokal im Browser)
- Echte 3D-Ansicht (Orbit), Laser-Richtung, Erfassungsrahmen und Tiefen-Grenze werden eingeblendet
- Ausrichtung: Seiten-Schnellwahl (Oben/Vorne/…), 90°-Schritte, Regler X/Y/Z, Rotations-Gizmo,
  „Aktuelle Ansicht übernehmen“ (Kamera-Blickrichtung wird zur Laser-Richtung)
- Tiefenbereich (wie tief ins Modell geschaut wird), dahinter schwarz oder transparent
- Rand/Zoom, Versatz, Größe fest (mm) oder Modellmaß 1:1
- Tiefen-Rendering per Shader mit 24-Bit-Genauigkeit und Supersampling (bis 3×)

### Bereich 2 – Bild → Relief
- Bild laden, Einpassen/Füllen, Zoom, Versatz, Drehung
- Hintergrund entfernen (Transparenz, Weiß, Schwarz, Eckfarbe, automatisch)
- Höhe aus Helligkeit (hell oder dunkel = hoch), Rauschfilter, Detailbetonung, Wölbung (Kissen-Effekt per Distanztransformation)
- **KI-Tiefe (Foto):** echte monokulare Tiefenschätzung mit *Depth Anything V2 Small* (Apache-2.0) über
  Transformers.js 4.3.2 / ONNX Runtime Web – WebGPU (fp16/fp32) mit Fallback auf WebAssembly (q8).
  Läuft im Browser; Bibliothek wird bei Bedarf von jsDelivr, das Modell (~27–50 MB) von Hugging Face geladen
  und im Browser-Cache gehalten. Optionen: KI-Auflösung (518/770/1036), Hintergrund nach Tiefe abschneiden,
  Foto-Struktur einmischen (Hochpass der Helligkeit).
- Große 3D-Gravurvorschau

### Gemeinsam
- Graustufen: Invertieren (Negativ-/Prägung), Schwarz-/Weißpunkt, Auto-Pegel, Gamma, Glättung (mm),
  Stufen (256 … 4), Grauwert-Bereich, Spiegeln, weiche Kanten
- Ausgabe: Voreinstellungen (Messing-Münze Ø 30/40/50, Kupfer, Edelstahl, Alu, Holz, Schiefer, Stufenrelief),
  Größe in mm, Auflösung in Linien/cm (≙ DPI), Form Rechteck/Kreis/abgerundet, Hintergrund transparent/weiß/schwarz
- 3D-Gravurvorschau auf Material (Messing, Kupfer, Edelstahl, Alu, Holz, Schiefer, Acryl) mit Überhöhung
- Histogramm, Tiefe pro Graustufe
- **PNG-Export** (RGBA, transparenter Hintergrund) mit eingebetteter DPI (pHYs-Chunk), damit die
  Größe in mm beim Import stimmt. Transparente Pixel haben Weiß als Farbwert (= keine Gravur, auch wenn Alpha ignoriert wird).

## Konvention
Weiß = Oberfläche (keine Gravur), Schwarz = tiefste Stelle. „Invertieren“ kehrt das um
(z. B. Gesicht als Negativ eingeprägt).

## Technik
- Reines HTML/CSS/JavaScript (ES-Module), **kein Build-Schritt**, keine Datenbank, kein Server-Code nötig
- Läuft auf jedem Standard-Webspace (z. B. mit PHP 8.1) direkt aus dem Verzeichnis
- Three.js r170 liegt lokal unter `vendor/three/`
- Einzige externe Quellen: Transformers.js (jsDelivr) und das KI-Modell (Hugging Face) – nur wenn „KI-Tiefe“ genutzt wird
- Einstellungen werden im `localStorage` des Browsers gemerkt

## Struktur
```
index.html            Oberfläche
css/style.css         Gestaltung
js/main.js            Einstieg, Bereichs-Umschaltung, Hilfe
js/model-mode.js      Bereich 1: 3D-Modell → Depthmap
js/image-mode.js      Bereich 2: Bild → Relief
js/ai-depth.js        KI-Tiefenschätzung (Depth Anything V2, lädt Transformers.js bei Bedarf)
js/heightmap.js       Graustufen-Pipeline, Glättung, Distanztransformation, PNG-Encoder
js/relief-preview.js  3D-Gravurvorschau
js/presets.js         Voreinstellungen, Materialien, gemeinsame Einstellungs-Sektionen
js/ui.js              UI-Bausteine (Panels aus Schema, Toast, Drag & Drop)
vendor/three/         Three.js (MIT-Lizenz)
.htaccess             MIME-Typen, Cross-Origin-Isolation (mehr CPU-Threads für die KI)
```

## Deployment
GitHub Actions (`.github/workflows/deploy.yml`) lädt bei jedem Push per FTP in den Unterordner
`depthmapper/` der Entwicklungs-Umgebung hoch. Zugangsdaten kommen ausschließlich aus den
Repository-Secrets `FTP_SERVER`, `FTP_USER`, `FTP_PASSWORD`.

## Lokal testen
```
python3 -m http.server 8000     # oder: php -S localhost:8000
```
Dann `http://localhost:8000` öffnen (ES-Module funktionieren nicht über `file://`).

## Ideen / offen
- STL-Export des Reliefs aus Bereich 2
- 16-Bit-PNG-Export
- Mehrere Motive auf einer Münze kombinieren (Vorder-/Rückseite)
