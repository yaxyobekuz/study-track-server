# Claude Code - Server Module Rules

> Global rules in root CLAUDE.md also apply.

## Stack

- Node.js + Express.js
- PostgreSQL + Prisma (ORM)
- JWT authentication
- DigitalOcean Spaces (S3) for file storage
- Winston for logging
- node-cron for scheduled jobs

## Project structure

```
server/
├── prisma/
│   └── schema.prisma  # Single source of truth for the DB schema
└── src/
    ├── config/        # prisma.js (PrismaClient singleton + extensions), env validation
    ├── controllers/   # Route handlers (thin, delegate to services)
    ├── generated/     # Prisma Client (generated — do not edit)
    ├── middleware/    # Auth, error, validation, upload
    ├── routes/        # Express routers
    ├── services/      # Business logic (fat services, thin controllers)
    ├── jobs/          # Cron jobs
    ├── helpers/       # Reusable pure functions
    ├── utils/         # idGenerator, objectId, password, constants, errors, JWT, logger, pagination
    └── scripts/       # One-time migration/setup scripts (incl. migrate-mongo-to-postgres)
```

## Data model (Prisma)

- The schema lives in `prisma/schema.prisma`. After editing it, run `npm run prisma:generate` (and `prisma migrate dev` in development) — never hand-edit `src/generated/`.
- IDs are `String @id @db.Char(24)` — 24-hex, ObjectId-compatible (preserved from the old MongoDB data). New rows get an auto-generated id from the `auto-id` extension in `config/prisma.js`; do not set `id` manually.
- Prisma model fields are camelCase; PostgreSQL columns/tables use snake_case via `@map`/`@@map`.
- Sensitive fields (`password`, `plainPassword`) must be excluded from reads with Prisma `omit`, never returned to clients.
- Mongoose virtuals/hooks are replaced by: computed fields in the `virtuals` extension (`config/prisma.js`), bcrypt hashing in the service layer, and settings singletons via `services/settings.service.js`.
- All access to the DB goes through the shared client: `require("../config/prisma")`.

## Middleware

- `auth.middleware.js` - verify JWT, attach `req.user`.
- `validate.middleware.js` - validate body/params against schema, reject early.
- `error.middleware.js` - single global error handler, never swallow errors.
- `async.middleware.js` - wrap async controllers to forward errors.

## Error handling

- Use `AppError(message, statusCode)` for all operational errors.
- Never send stack traces to the client in production.
- The global error handler in `error.middleware.js` is the only place that sends error responses.

## Environment variables

- All env vars are validated at startup in `config/env.config.js`.
- Never access `process.env` directly in business code - import from config.
- Keep `.env.example` up to date when adding new variables.

## File uploads

- Use `upload.middleware.js` (Multer) for multipart requests.
- Validate file type and size before processing.
- Store files in DigitalOcean Spaces via `fileStorage.service.js`.
- Never serve files from the local `uploads/` folder in production.

## Cron jobs

- All scheduled jobs live in `src/jobs/`.
- Each job file exports a single `start()` function.
- Jobs must log start/end/errors via `logger`.
- Jobs must not crash the process - wrap logic in try/catch.

## Logging

- Use the shared `logger` from `utils/logger.js` everywhere.
- Log levels: `error` for failures, `warn` for unexpected states, `info` for key events.

## Pagination

- All list endpoints must support pagination.
- Use the shared `pagination` utility from `utils/pagination.js`.
- Response shape for lists: `{ success, data, pagination: { page, limit, total, ... } }`.

## Code style

- Use `async/await` - no `.then()/.catch()` chains.
- One export per controller/service file (named exports preferred).
- File naming: `<name>.<type>.js` (e.g., `user.service.js`, `auth.controller.js`).
