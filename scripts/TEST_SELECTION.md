# Fast test selection

The full suite (about 2,400 tests in 150 files) is the gate before a merge into `dev`. In the middle of a module build use the
selection runner instead. It is `scripts/test-module.mjs`; the test database is `societyapp_test` as always (one run at a time).

## Workflow

| When                                                              | Command                                  |
| ----------------------------------------------------------------- | ---------------------------------------- |
| Many times while building a module                                | `npm run test:module -- <name>`          |
| After a change that crosses modules (models, ports, lib, routes)  | `npm run test:changed`                   |
| After adding a table, route, permission, setting, queue, approval | `npm run test:contracts`                 |
| Once before each merge into `dev`, and after any shared change    | the FULL suite (the shard or RAM runner) |

`<name>` is a folder of `tests/modules/` (payments, billing, residents, society-setup, societies, access-control, auth, committee,
platform-billing, platform-ops, subscriptions, ...). `health` runs `tests/health.test.ts`. A module without a test folder (for
example `dev`) runs the tests that import its files. `test:module` always adds the contract list; `--no-contracts` leaves it out.

Flags: `--explain` prints the plan (files and reasons) and runs nothing. `test:changed -- --base <ref>` compares against `<ref>`
(default `dev`); `--head <ref>` replays a past range and ignores the working tree. Arguments after a second `--` go to vitest.

## Contract tests

`scripts/test-contract-list.txt` lists the tests that break when any module adds tables, routes, permissions, settings, queues,
approval types or env variables (registry and route-table counts, tenant isolation of every route, export providers, catalogue
counts, dev approval dispatch). One line each with the reason. Add a line when you write a test that enumerates a registry.

## How `test:changed` selects

Changed files come from `git diff <base>...HEAD`, the working tree and untracked files.

- `tests/**/*.test.ts`: the file itself. `tests/helpers/*`: the tests that import it (directly or through other helpers).
- `src/modules/<x>/*`: all of `tests/modules/<x>/`, plus tests that import the file. If the file is a port (`public.ts`,
  `*.ports.ts`, `*.public.ts`) the folders of the modules that import it (consumers) are added too.
- `src/lib`, `middlewares`, `models`, `types`, `utils`, `adapters`, `config`: the modules that import the file (import graph built
  from the source, through other shared files) and their folders. `lib`, `middlewares`, `models`, `types` also add the baseline
  `access-control` + `auth`.
- `migrations/*`: baseline, plus the models of the tables the migration touches and their importers.
- `src/app.ts`, `src/models/index.ts`, `src/server.ts`, `src/worker.ts`, `scripts/seed.ts`: baseline. `seeders/*`: tests importing it
  and the folder of the same name.
- `package-lock.json`, vitest/tsconfig/env files: a warning "full suite recommended" (the selection is then a smoke run only).
- Always: the contract list.

Caps: a helper used by more than 40 test files, or a shared or port file whose importing modules own more than 40 test files, is
not expanded and a WARNING is printed. Then only the baseline and contracts run: run the full suite unless the change is additive.

## Limits

- Selection is by static imports. A test that reaches code only through the app (HTTP route, queue, dynamic path) is found only
  through the folder rule or the contract list. It is a speed tool, not a proof: the full suite stays the gate.
- A change inside a module's own non-port file does not pull in other modules, even if they use its behaviour through HTTP.
- Do not run two runners on the same database at once.
