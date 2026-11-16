# Faster full test runs (RAM MySQL + 8 shards)

The full suite is slow mainly because of MySQL disk writes and because files run one after another.
Two scripts fix this: a second private MySQL whose data lives in RAM, and a shard runner.

## Use

```bash
npm run test:ram:start     # starts MySQL on 127.0.0.1:3308, data in /dev/shm/societyapp-mysql-test
npm run test:shards        # 8 shards; or: bash scripts/test-shards.sh 6
npm run test:ram:stop      # stops only the instance named in its own pid file
bash scripts/test-ram-mysql.sh status
```

`test:shards` starts the RAM MySQL if needed, creates `societyapp_shard_1..N`, migrates each, runs
`vitest run --shard=i/N` in parallel, prints one line per shard, the failing tests, the wall time and
the exit code, then drops the shard databases. Logs stay in the temp directory named on the last line.

## How the database is chosen

`DATABASE_URL` in the environment beats `.env` and `.env.test` (dotenv never overrides existing
variables), for both `sequelize-cli` and vitest. The runner sets it per shard.

## After a reboot

`/dev/shm` is wiped on reboot. `test-ram-mysql.sh start` notices the missing data directory and
initialises it again (a few seconds). Nothing to do by hand.

## Warning

The RAM instance runs without fsync, without doublewrite and without a binary log. It is for
throwaway test data ONLY. Never point the dev database (`societyapp`, port 3307) or anything you
want to keep at it. It uses its own port (3308) and never touches the dev MySQL.

## Measured (2,498 tests, 150 files, 8 CPUs, other jobs were also running, load 10-13)

| Setup                | Wall time     |
| -------------------- | ------------- |
| 6 shards, disk MySQL | about 1,500 s |
| 6 shards, RAM MySQL  | 1,052 s       |
| 8 shards, RAM MySQL  | 899 s         |

All tests passed in both RAM runs. Migrating each shard takes 9-12 s (in parallel). The run is CPU-bound
(65 min of user CPU), so more shards than CPUs do not help; shard sizes are uneven (573 to 882 s).

## Where the CPU goes (profile of `tests/modules/residents/moves.test.ts`, 27 tests)

`--cpu-prof` of the vitest worker (`--execArgv=--cpu-prof`; `NODE_OPTIONS=--cpu-prof` alone loses the worker's
profile because the worker is killed) plus thread sampling with `top -H`:

1. argon2id password hashing in the fixture helpers (`tests/helpers/auth.ts` `makeUser`, 64 MiB, 3 passes,
   150-300 ms each, runs in the libuv thread pool so it does not show in the JS profile). About 35-40% of a
   file's wall time before the change (52 s to 33 s on `moves.test.ts`).
2. Sequelize (query building, model instances) plus lodash: about 8-10 s of 31 s, from fixture creation.
3. Node internals (socket writes) and mysql2: about 4-5 s.
4. MySQL server: about 9 s of CPU per 30 s file.
5. Module import and transform: 10-15% per file (150 files, each imports the whole app).

TypeScript is transformed by esbuild/rolldown through vite, not ts-node, so it is not a hot spot.

## What changed (opt-in)

`tests/setup/fast-argon.ts` is loaded by `vitest.config.mts` only when `TEST_FAST=1`. It makes password hashes
created from `tests/helpers/*` cheap (1 MiB, 1 pass); everything else (real signup flows, the unit test that
asserts the production parameters) keeps the real cost. `verify` reads the cost from the stored hash, so
logins of fixture users are cheap too. No production code changed. `test:shards` sets `TEST_FAST=1`
by default; `TEST_FAST=0 npm run test:shards` turns it off. Plain `npm test` is unchanged.

## Rejected

- `isolate: false` / one shared worker: the tests share module state (clock, queues, ACL cache), so
  not safe without editing tests.
- Lowering the cost in `src/modules/auth/auth.crypto.ts` through an env variable: it would change
  production code, and `passwordNeedsRehash` would then rehash on login.

## Result of the change

Single file `moves.test.ts`: 52 s before, 31 s after (quiet machine). Full suite, 8 shards: 838 s and 911 s, both
with the machine heavily loaded by other jobs (load average 12-19 on 8 CPUs), so the gain on the full suite
could not be isolated; 2,498 of 2,498 passed on the second run. The first run had one failure in
`payments.receipts.test.ts` ("PENDING is RECEIPT_NOT_READY"), a timing race against the in-process job queue
under load; it passes alone with and without `TEST_FAST` and passed in the second full run.
