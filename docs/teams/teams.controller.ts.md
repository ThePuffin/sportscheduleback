# File: `backend/src/teams/teams.controller.ts`

## Purpose

This controller exposes team-related API endpoints for the frontend and admin tooling.

## Key Features

- Returns all teams or teams for a specific league
- Exposes the list of available leagues
- Supports team refresh and admin updates/deletes

## Main Endpoints

- `GET /teams` — returns all teams
- `GET /teams/leagues` — returns available leagues
- `GET /teams/league/:league` — returns teams from one league
- `GET /teams/:uniqueId` — returns a single team
- `POST /teams/refresh` — refreshes team data for one or all leagues
- `PATCH /teams/:uniqueId` — updates a team
- `DELETE /teams/all` — deletes all teams
- `DELETE /teams/league/:league` — deletes a league’s teams
- `DELETE /teams/:uniqueId` — deletes one team

## Data Flow

1. The client requests team data.
2. The controller passes the request to `TeamService`.
3. The service returns normalized team records.
