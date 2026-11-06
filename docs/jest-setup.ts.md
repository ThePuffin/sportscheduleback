# Jest ESM setup

## Purpose

Expose Jest's `jest` API as a global for the existing test files after Jest
switches to native ESM mode for NestJS 12.

## Behavior

`@jest/globals` is imported explicitly and its `jest` object is added to
`globalThis`. The setup is loaded before each test suite through
`setupFilesAfterEnv` in `package.json`.
