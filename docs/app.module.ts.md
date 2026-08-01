# File: `backend/src/app.module.ts`

## Purpose

The root NestJS application module wires all backend features together and initializes the MongoDB connection.

## Key Features

- **Global config** — loads environment variables through `ConfigModule`
- **Database bootstrap** — connects to MongoDB using `MongooseModule.forRoot()`
- **Feature module registration** — imports the cron scheduler, team module and game module
- **Controller/provider registration** — exposes `AppController` and `AppService`

## Key Components

- `ConfigModule.forRoot({ isGlobal: true })`
- `MongooseModule.forRoot(databaseUri, { dbName, useBigInt64: true, auth })`
- `CronModule`
- `TeamModule`
- `GameModule`

## Data Flow

1. The application starts and loads environment variables.
2. The database URI and credentials are resolved from environment variables.
3. NestJS registers the cron service and all business modules.
4. The app is ready to serve requests and background refresh jobs.
