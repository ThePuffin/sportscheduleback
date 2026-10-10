#!/usr/bin/env node
/**
 * Safe Jest launcher.
 *
 * WHY THIS EXISTS
 * ---------------
 * The VS Code "Console Ninja" extension injects itself into every Node process
 * spawned from the integrated terminal by prepending
 *   --require "~/.console-ninja/.bin/loader.js"
 * to NODE_OPTIONS. Its buildHook overrides every console.* method and, for each
 * log call, dumps the stack trace together with the *entire source* of the file
 * it resolves to (its own ~3 MB obfuscated single-line bundle). Because
 * `games.service.ts` logs a lot during the test suite, a single run could emit a
 * ~250 MB stream into the VS Code terminal, freezing and crashing the editor
 * (Node also reported native crashes retrying a dead Console Ninja socket).
 *
 * This wrapper spawns Jest in a child process with NODE_OPTIONS stripped of the
 * Console Ninja loader (see stripConsoleNinjaFromNodeOptions), so the hook never
 * loads and the test output stays tiny. It also forwards every CLI argument to
 * Jest and adds `--silent` by default to keep the terminal output clean; pass
 * `--verbose` (or any flag) yourself to override that default.
 *
 * Usage: node scripts/run-jest.js [any jest args...]
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const LOADER_TOKEN = '.console-ninja';

/**
 * Remove the Console Ninja loader from a NODE_OPTIONS string while keeping any
 * other legitimate options (e.g. --max-old-space-size). Returns '' when nothing
 * remains so the child process runs without NODE_OPTIONS at all.
 *
 * Console Ninja injects itself as `--require "<path-to-loader.js>"`. We must
 * drop the flag *and* its path argument together — removing only the path
 * would leave a dangling `--require` that makes Node fail to start.
 * @param {string | undefined} value
 * @returns {string}
 */
function stripConsoleNinjaFromNodeOptions(value) {
  if (!value) return '';

  const tokens = value.split(/\s+/).filter((t) => t.length > 0);
  const kept = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Inline form: --require=/path or -r=/path
    const inlineMatch = token.match(/^(--require|-r)=(.*)$/);
    if (inlineMatch) {
      if (inlineMatch[2].includes(LOADER_TOKEN)) continue; // drop whole token
      kept.push(token);
      continue;
    }

    // Split form: --require <path> / -r <path>
    if (token === '--require' || token === '-r') {
      const next = tokens[i + 1];
      if (next !== undefined && next.includes(LOADER_TOKEN)) {
        i++; // consume the path argument too
        continue;
      }
      // Keep the flag and its (legitimate) argument as-is.
      kept.push(token);
      if (next !== undefined) {
        kept.push(next);
        i++;
      }
      continue;
    }

    // Any other stray token that references the loader (defensive).
    if (token.includes(LOADER_TOKEN)) continue;

    kept.push(token);
  }

  return kept.join(' ').trim();
}

const jestBin = path.join(
  __dirname,
  '..',
  'node_modules',
  'jest',
  'bin',
  'jest.js',
);

// Only inject --silent when the caller did not ask for a verbosity flag, so
// `node scripts/run-jest.js --verbose` behaves exactly like plain Jest.
const userArgs = process.argv.slice(2);
const hasVerbosityFlag = userArgs.some((a) =>
  /^--(verbose|silent)$/.test(a),
);
const jestArgs = hasVerbosityFlag ? userArgs : ['--silent', ...userArgs];

const cleanedNodeOptions = stripConsoleNinjaFromNodeOptions(
  process.env.NODE_OPTIONS,
);

// Copy the environment, then drop the Console Ninja loader from NODE_OPTIONS.
// When nothing legitimate remains we delete the variable entirely.
const childEnv = { ...process.env };
if (cleanedNodeOptions) {
  childEnv.NODE_OPTIONS = cleanedNodeOptions;
} else {
  delete childEnv.NODE_OPTIONS;
}

// Also remove the Console Ninja shim directory from PATH so a stray
// `console-ninja`/`node` wrapper on PATH cannot re-inject itself.
if (typeof childEnv.PATH === 'string') {
  childEnv.PATH = childEnv.PATH.split(path.delimiter)
    .filter((dir) => !dir.includes(LOADER_TOKEN))
    .join(path.delimiter);
}

const result = spawnSync(process.execPath, [jestBin, ...jestArgs], {
  stdio: 'inherit',
  env: childEnv,
});

if (result.error) {
  console.error('Failed to launch Jest:', result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
