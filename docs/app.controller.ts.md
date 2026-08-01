# File: `backend/src/app.controller.ts`

## Purpose

This controller exposes a minimal health endpoint for the backend.

## Key Features

- Provides a lightweight `GET /ping` endpoint
- Used as a simple availability check for monitoring or deployment validation

## Key Function

### `ping()`

Returns the string `Pong`.

## Data Flow

1. A client or monitoring system calls `GET /ping`.
2. The controller responds immediately with a static success payload.
