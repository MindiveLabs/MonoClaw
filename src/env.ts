/**
 * Loads config/.env into process.env at module-evaluation time.
 *
 * Import this as the FIRST import in src/index.ts so that env vars are set
 * before any channel modules read them during their own module evaluation.
 *
 * Rules:
 *   - Blank lines and lines starting with # are ignored.
 *   - KEY=VALUE sets process.env.KEY = VALUE (strips surrounding quotes).
 *   - Never overwrites a variable that is already set in the environment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(process.cwd(), 'config', '.env');

if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();

    // Strip surrounding single or double quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Never clobber vars already set by the environment
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
