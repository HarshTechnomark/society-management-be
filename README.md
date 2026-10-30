# society-api

Backend for SocietyApp: Node.js, Express, TypeScript, MySQL 8 (Sequelize) and Zod.
Module 01 (project foundation) provides the structure only. Each feature is added in its own module branch.

## Start

```bash
pnpm install
cp .env.example .env            # then edit DATABASE_URL
pnpm migrate                    # runs the Sequelize migrations
pnpm dev                        # http://localhost:4000/api/v1/health
```

## Scripts

| Command                                                        | What it does                                   |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm dev`                                                     | start the API with reload                      |
| `pnpm build` / `pnpm start`                                    | compile to `dist/` and run it                  |
| `pnpm typecheck` / `pnpm lint` / `pnpm format`                 | checks                                         |
| `pnpm test`                                                    | Vitest, uses `.env.test` (a separate database) |
| `pnpm migrate` / `pnpm migrate:undo` / `pnpm migrate:undo:all` | database migrations                            |

## Layout

```
src/
  modules/<module>/   one folder per module: routes, controller, service, validation, types, jobs
  middlewares/        requestId, validate, error (auth, society, permission, entitlement come with modules 02 to 04)
  lib/                env, logger
  utils/              errors, response envelope, asyncHandler
  models/             Sequelize connection; one model file per table, added by the module that owns it
  config/             Sequelize CLI configuration
  adapters/           provider interfaces and fakes (added by the modules that use them)
  app.ts  server.ts   Express assembly and entry point
migrations/  seeders/  tests/
```

## Git

`main` is production, `dev` is integration, work happens on `module/<NN>-<name>` branches made from `dev`
(see `CODING_STANDARDS.md` section 4.4). Commits follow Conventional Commits.
