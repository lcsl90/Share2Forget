# Share2Forget

Ein leichtgewichtiger, selbst gehosteter Dienst, um im eigenen Netzwerk schnell Links, Nachrichten
und Dateien zwischen Geräten auszutauschen – z. B. vom Windows-PC auf das MacBook.

Alles läuft in Channels, die über einen **5-stelligen Code** (Buchstaben und Zahlen,
Groß-/Kleinschreibung zählt) identifiziert werden. Auf Wunsch mit Passwort. Alles liegt nur im
Arbeitsspeicher bzw. Temp-Verzeichnis des Containers: Neustart oder Löschen des Channels – und alles
ist vergessen. Daher der Name.

## Features

- **Channel-Übersicht** als Startseite, mit Live-Anzeige, wer online ist
- **Channels erstellen** – der 5-stellige Code wird automatisch zufällig generiert, optional mit Passwort
- **Channels löschen** – bei passwortgeschützten Channels nur mit Passwort
- **Beitreten per Code** von jedem Gerät im Netzwerk (`http://<server-ip>:8080`, Code eingeben, fertig)
- **Chat in Echtzeit** über SignalR/WebSockets, Links werden automatisch klickbar
- **Rich-Text-Chat**: fett, kursiv, unterstrichen, durchgestrichen, Zitate, Listen, Tabellen,
  Inline-Code – per Toolbar, Tastenkürzel (Strg+B/I/U/E/K) oder Markdown-Kurzbefehlen
  (`>`, `-`, `1.`, `` ` `` und ` ``` ` beim Tippen)
- **Formatiert einfügen**: aus Word, Google Docs, Websites etc. kopierter Text kommt mit
  Formatierung an; eingefügter Code/YAML/JSON wird automatisch erkannt
- **Code-Fenster mit Syntax-Highlighting** (highlight.js, lokal gebündelt) inklusive
  automatischer Spracherkennung, Sprach-Label und Kopieren-Button
- **Formatiert kopieren**: jede Nachricht lässt sich per Klick 1:1 formatiert in die
  Zwischenablage übernehmen (HTML + Plaintext)
- **Dateien senden** per Button oder Drag & Drop, mit Fortschrittsanzeige und Bildvorschau;
  Screenshots können direkt aus der Zwischenablage eingefügt werden
- **Automatisches Vergessen**: leere, inaktive Channels werden nach 24 h aufgeräumt (konfigurierbar)

## Schnellstart

```bash
docker compose up -d --build
```

Danach im Browser öffnen:

- auf dem Server selbst: <http://localhost:8080>
- von anderen Geräten im Netzwerk: `http://<IP-des-Servers>:8080`

Typischer Ablauf: Auf dem Windows-PC einen Channel erstellen, den angezeigten Code (z. B. `Ab3x9`)
auf dem MacBook eingeben – und Links, Texte und Dateien landen sofort auf beiden Geräten.

### Regeln beim Erstellen und Beitreten

- **Erstellen** erzeugt immer einen zufälligen, garantiert freien 5-stelligen Code und zeigt eine
  Bestätigung an.
- **Beitreten** zu einem Code, den es nicht gibt → Hinweis „Hier ist niemand“, sonst passiert nichts.

## Konfiguration

Umgebungsvariablen (siehe `docker-compose.yml`):

| Variable            | Standard | Bedeutung                                                    |
| ------------------- | -------- | ------------------------------------------------------------ |
| `MAX_FILE_MB`       | `1024`   | Maximale Dateigröße pro Upload in MB                          |
| `CHANNEL_TTL_HOURS` | `24`     | Leere, inaktive Channels nach dieser Zeit löschen (`0` = nie) |
| `DATA_DIR`          | Temp     | Ablageort für hochgeladene Dateien im Container               |

Der Port lässt sich in der `docker-compose.yml` ändern (`"8080:8080"` → z. B. `"9000:8080"`).

## Entwicklung ohne Docker

.NET 10 SDK installieren, dann:

```bash
dotnet run --project src/Share2Forget
```

## Technik

- ASP.NET Core 10 Minimal API + SignalR – **ohne einzige NuGet-Abhängigkeit**
- Vanilla-JS-Frontend, SignalR-Browser-Client und highlight.js liegen lokal bei
  (läuft komplett offline im LAN)
- Rich-Text wird als Whitelist-sanitiertes HTML übertragen: die Clients sanitizen
  DOM-basiert beim Rendern, der Server zusätzlich beim Empfang (eigener Sanitizer ohne
  Abhängigkeiten)
- Channels, Nachrichten und Datei-Metadaten im RAM (max. 300 Nachrichten pro Channel),
  Datei-Inhalte im Temp-Verzeichnis; Passwörter als PBKDF2-Hash
- Zugriffsschutz über ein Channel-Token, das erst nach Passwortprüfung herausgegeben wird
- Multi-Stage-Dockerbuild auf Alpine-Basis, läuft als Non-Root-User

## Hinweis

Gedacht für das eigene, vertrauenswürdige Netzwerk. Der Dienst spricht unverschlüsseltes HTTP –
nicht ohne Reverse-Proxy mit TLS ins Internet stellen.
