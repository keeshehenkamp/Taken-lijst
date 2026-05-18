# Takenlijst

Een zelfstandige to-do webapp die lokaal in de browser draait. Geen installatie, geen server, geen internet nodig.

## Opstarten

Open `index.html` door erop te dubbelklikken. De app opent in je standaardbrowser.

## Bestanden

| Bestand    | Inhoud |
|------------|--------|
| `index.html` | HTML-structuur en alle modals |
| `style.css`  | Opmaak (kleuren, layout, responsief) |
| `app.js`     | Alle logica, opgesplitst in genummerde secties |
| `firebase-sync.js` | Firebase Authentication en Firestore-koppeling |
| `manifest.json` / `icon.svg` / `sw.js` | PWA-bestanden (installeerbaar, offline) |
| `README.md`  | Dit bestand |

## Layout

- **Desktop** (≥980px): twee kolommen — takenlijst links, chat-paneel als sticky zijbalk rechts.
- **Mobiel** (<980px): één kolom, chat als vaste balk onderaan het scherm.
- **Groepering**: openstaande taken worden gegroepeerd per tijdvak — *Te laat*, *Vandaag*, *Morgen*, *Deze week*, *Later*, *Geen deadline*, *Afgerond*.
- **Datumblok**: elke taak heeft een prominent datumblok vooraan met maand boven en dag groot eronder (kleur indien te laat of urgent).

## Codestructuur (`app.js`)

De code is ingedeeld in zeven secties, herkenbaar aan de kopregel `// ── N. NAAM ──`:

1. **State & localStorage** — laden, opslaan, unieke ID's genereren
2. **Datumherkenning** — vertaalt vrije tekst naar een YYYY-MM-DD deadline
3. **Chat-flow** — verwerkt invoer en stuurt de twee-staps keuzeflow aan
4. **Taakbeheer** — renderen (gegroepeerd per tijdvak), sorteren, filteren, datumblok bouwen, afvinken, bewerken, verwijderen
5. **Categoriebeheer** — toevoegen, hernoemen, verwijderen met taakbehoud
6. **Export / Import** — JSON-bestand downloaden of inladen
7. **Event-listeners & initialisatie** — alle DOM-koppelingen en opstartcode
8. **Cloud-sync** — Firebase Auth + Firestore: inloggen, ophalen, schrijven en realtime listener

## Cloud-synchronisatie

Zonder inloggen werkt de app volledig lokaal via `localStorage` (privé op het apparaat).

Met inloggen via Google synchroniseren taken en categorieën realtime tussen al je apparaten via Firestore. `localStorage` blijft fungeren als offline cache, zodat de app ook werkt zonder internet en wijzigingen automatisch worden geüpload zodra je weer online bent.

Bij de eerste keer inloggen waar zowel het apparaat als de cloud al data bevatten verschijnt een dialoog om te kiezen welke set behouden moet blijven. In andere situaties (één van beide leeg) gaat de migratie automatisch.

De Firestore security rules staan zo dat alleen jij (ingelogd) je eigen documentpad `users/{uid}` kunt lezen en schrijven.

## Datumherkenning

Ondersteunde patronen (Nederlands):

- `vandaag`, `morgen`, `overmorgen`
- `volgende week`
- `over N dagen / weken / maanden`
- Weekdagnamen: `maandag` t/m `zondag` (ook verkorte vorm: `ma`, `vr`, enz.)
- Maandnamen: `25 mei`, `3 oktober 2026`
- Numeriek: `25-05`, `25/05`, `25-05-2026`
- Voorzetsels worden genegeerd: "voor vrijdag", "op 25 mei", "uiterlijk morgen"

Als er geen datum herkend wordt, wordt de volledige invoer als taaknaam gebruikt.

## Data

Taken en categorieën worden opgeslagen in `localStorage` onder de sleutels `todoapp_tasks` en `todoapp_categories`. Gebruik de knoppen **Exporteren** en **Importeren** in de header om een JSON-back-up te maken of te herstellen.

## Uitbreiden

De app heeft geen build-stap. Wijzigingen in `style.css` of `app.js` zijn direct zichtbaar na een paginaverversing. In Claude Code kun je gewoon vragen "voeg een herhaalfunctie toe aan taken" of "maak de accentkleur groen" en het bestand wordt direct bijgewerkt.
