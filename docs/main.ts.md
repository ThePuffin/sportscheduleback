# File: `backend/src/main.ts`

## Purpose

This is the application bootstrap file for the NestJS server.

## Key Features

- Creates the Nest application from `AppModule`
- Enables CORS for frontend requests
- Applies the `helmet` middleware for security headers
- Loads environment variables with `dotenv`
- Starts the server on the configured port (default `3000`)

## Key Function

### `bootstrap()`

1. Creates the Nest app instance.
2. Enables CORS.
3. Adds security middleware.
4. Starts listening on `PORT` or `3000`.

## Data Flow

1. The Node process starts.
2. `main.ts` loads env variables and initializes the Nest app.
3. The HTTP server begins listening for incoming requests.
