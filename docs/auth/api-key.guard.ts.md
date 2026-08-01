# File: `backend/src/auth/api-key.guard.ts`

## Purpose

This guard protects admin-oriented HTTP routes with an API key check.

## Key Features

- Reads the `x-api-key` header from incoming requests
- Validates it against the `EXPO_PUBLIC_API_KEY` environment variable
- Throws `401 Unauthorized` if the key is missing or invalid

## Data Flow

1. A request hits a guarded route.
2. The guard extracts the API key header.
3. The key is compared with the server config.
4. If it matches, the request continues; otherwise it is rejected.
