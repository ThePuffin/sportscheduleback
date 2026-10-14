# File: `backend/src/utils/fetchData/scrappingData.ts`

## Purpose

Scraping adapter for schedule sources that do **not** expose a documented public API. The first
source is the **Synerglace Ligue Magnus** calendar (https://liguemagnus.com/calendrier/). For now
it only fetches the raw fixtures and prints them with `console.log`; ingesting them into the
database (games **and** teams) is a later step.

## Why there is no HTML parsing (no cheerio)

The calendar page ships an **empty** container — `<div class="calendrier-general-compet"></div>` —
and its filters (`.formulaire-calendrier`) are populated client-side. The fixtures are loaded by the
site's own JavaScript, which calls the WordPress AJAX endpoint:

```
GET https://liguemagnus.com/wp-admin/admin-ajax.php?action=get_rencontres&phase_id=714&par_page=1000&limite=0&page=1
```

That endpoint answers JSON produced from the hockeynet.fr feed, so the scraper talks to it directly
with the global `fetch` (same stack as `hockeyData.ts` / `espnAllData.ts`, no new dependency). The
`User-Agent`/`Accept` headers mirror the browser identity used for ESPN, and the request carries the
same 15s `AbortController` timeout idea as `fetchWithTimeout()` in `espnAllData.ts`.

## Endpoint parameters

- `action=get_rencontres` — fixed.
- `phase_id` — defaults to **`714`**, the `poule` id of the "Saison régulière" of 2026-27
  (15/09/2026 → 02/03/2027, 264 fixtures, 12 clubs). **Phase ids are season-specific**: re-read the
  `poule` query parameter of the calendar page when the season changes.
- `page` / `par_page` (default 1000) / `limite=0` — pagination; `meta.last_page` drives the loop.
- Optional filters mapped 1:1 from `LigueMagnusQuery`: `competition_id`, `date_min`, `date_max`,
  `journee`, `equipe_id`.

## Key Types

- `LigueMagnusRencontre` — one fixture: `id`, `date_rencontre` (`"YYYY-MM-DD HH:mm"`, Europe/Paris),
  `receveur` (home) / `visiteur` (away) teams, `score[]` keyed by `equipe_id`, `etat`, `victoire_par`,
  `lieu_de_pratique`, `tour`, `phase`, `competition`.
- `LigueMagnusTeam` — `id`, `libelle` (`"93006S - RAPACES DE GAP"`), `libelle_complet`,
  `libelle_court` (`"GAP"`), `abreviation`, `logo`.
- `LigueMagnusQuery` — the filters accepted by the scraper.

`etat` observed values: `"T"` (finished), `"R"` (postponed), `null` (not played yet).
`victoire_par`: `"S"` (shootout), `"PRL"` (overtime), `"TAB"` (shootout).

## Key Functions

- `buildLigueMagnusUrl(query, page)` — pure URL builder (exported for tests).
- `ScrappingData.getRencontresPage()` *(private)* — one HTTP call; throws on non-2xx or on a
  `success: false` payload.
- `ScrappingData.getLigueMagnusRencontres(query?)` — walks pages until `meta.last_page`, **dedupes
  by rencontre `id`** (a wrapping cursor must never double-count games), and logs one fetched-match
  count per page to keep the crawl observable.
- `ScrappingData.scrapeLigueMagnus(query?)` — entry point: fetch + three logs (per-page progress,
  one-line-per-fixture summary via `formatRencontreLine`, then the full raw array). Returns the raw
  fixtures, or `[]` on failure with a `console.error`, matching `HockeyData` / `ESPNAllData`
  error handling.
- `formatRencontreLine(rencontre)` — e.g. `2026-09-15 20:00  GAP 2 - 1 CHAMONIX`; `-` when no score
  yet, `(Reporté)` for postponed games.

## Data Flow

```
scrapeLigueMagnus(query)
  └─ getLigueMagnusRencontres()           # pagination + dedupe + per-page logs
       └─ getRencontresPage()             # fetch admin-ajax.php?action=get_rencontres
  └─ console.log(summary / fixture lines / raw array)
  └─ LigueMagnusRencontre[]  (or [] on error)
```

## Current Scope & Next Steps

Current scope is **read-only + `console.log`**: nothing is written to MongoDB, and no league is
registered. The later integration step will need: a `League` enum value, a mapping
`LigueMagnusRencontre → GameFormatted` (home/away scores from the `score[]` array, status from
`etat`, `gameDate` from `date_rencontre`), a mapping `LigueMagnusTeam → TeamType` (logos come from
hockeynet.fr), and hooks in `GameService` / `TeamService` alongside the ESPN and PWHL providers.
