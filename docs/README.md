# Backend documentation index

This folder contains AI-friendly documentation for the main backend modules.

## Main entry points

- [app.module.ts](app.module.ts.md) — root NestJS module wiring and MongoDB bootstrap
- [app.controller.ts](app.controller.ts.md) — simple health endpoint
- [app.service.ts](app.service.ts.md) — application service placeholder
- [main.ts](main.ts.md) — server bootstrap and middleware setup

## Feature modules

- [games/games.controller.ts](games/games.controller.ts.md) — REST endpoints for games
- [games/games.service.ts](games/games.service.ts.md) — game fetching, enrichment, refresh and sync logic
- [teams/teams.controller.ts](teams/teams.controller.ts.md) — REST endpoints for teams
- [teams/teams.service.ts](teams/teams.service.ts.md) — team import, persistence and generated frontend constants

## Supporting modules

- [auth/api-key.guard.ts](auth/api-key.guard.ts.md) — API key protection for admin routes
- [cronJob/cronJob.service.ts](cronJob/cronJob.service.ts.md) — scheduled refresh jobs
- [utils/utils.ts](utils/utils.ts.md) — league season helpers and refresh decision logic
