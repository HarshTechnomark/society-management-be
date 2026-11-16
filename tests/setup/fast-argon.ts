// Opt-in (TEST_FAST=1): hashing the fixture users' passwords at production cost (64 MiB, 3 passes,
// about 150-300 ms each) is most of the suite's CPU. Hashes made by tests/helpers/* use a cheap cost;
// verify() reads the cost from the stored hash, so logins stay cheap and behave the same. Hashes made
// anywhere else (the real signup flows, the unit test that checks the parameters) keep the real cost.
import argon2 from 'argon2';

const realHash = argon2.hash.bind(argon2);
const cheap = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const patched = argon2 as { hash: typeof argon2.hash };

patched.hash = ((plain: Buffer | string, options?: Parameters<typeof argon2.hash>[1]) => {
  const fromHelper = (new Error().stack ?? '').includes('/tests/helpers/');
  return realHash(plain, fromHelper ? { ...options, ...cheap } : options);
}) as typeof argon2.hash;
