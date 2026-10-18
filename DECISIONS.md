# Decisions

Choices made where the brief left room. Simpler option first; revisit if it hurts.

## Milestone 1

### Step 1: TypeScript
- **ESM with `.js` import specifiers** (`module: NodeNext`). Keeps the existing layout and lets `tsc` emit
  runnable ESM without a bundler or path rewriting.
- **Tests stay on `node:test`, run through `tsx --test`.** No new framework for the API; Vitest is only
  added in rasid-web (step 7).
- **`strict` + `noUncheckedIndexedAccess`.** FBR responses stay typed as `any` (`FbrJson`) because PRAL's
  shapes vary by endpoint; the route code only reads a few known fields.
- **Seeding runs from source in dev** (`npx tsx --env-file=.env src/seed.ts` / `npm run seed`) and from
  `dist/seed.js` in the image.
- **Reference-list lookup uses `Object.hasOwn`.** The JS version used truthiness on `PATHS[kind]`, which
  let prototype keys like `toString` through. That's the only behaviour change in this step.
