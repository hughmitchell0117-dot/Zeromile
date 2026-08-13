# Agent instructions

This file is read by Codex. `CLAUDE.md` symlinks to it so Claude Code reads the
same instructions — keep guidance here, not in two places.

## Project

ZeroMile — a pitch site and live simulator for chained freight dispatch in
Korea. Instead of matching a driver to one load, it matches them to a 2–4 leg
tour that ends back at their depot. React + TypeScript + Vite; the solver
(simulated annealing over tour construction) runs in the browser.

Layout: `src/lib` holds geography, freight economics, the load generator and
the solver; `src/components` holds the map, the demo console and the driver
phone; `src/App.tsx` is the page.

**The map and the distances are real.** The basemap is OpenStreetMap vector
tiles rendered by MapLibre (OpenFreeMap's dark style — no API key). Every
distance, drive time and corridor shape in `src/data/` is real OSRM routing
over OSM, fetched once by `npm run bake` and committed. Nothing routes at
runtime. `src/lib/sites.ts` is the 75 real docks freight actually moves
between; `src/lib/geo.ts` is now just the 30 city centroids.

Do not re-run `npm run bake` casually — it hits OSRM's public demo server for
435 routes at one request per 650ms. It is resumable, so a re-run only fetches
what is missing. Re-bake when `sites.ts` or the city list changes.

## Do not test with browser use

**The humans do all visual testing.** Do not verify your work by opening the
preview, screenshotting the page, clicking through the UI, or reading the
rendered DOM to confirm a change looks right. That is our job, not yours.

Your verification is `npm run build` (typecheck + bundle) and `npm run lint`.
If a change genuinely can't be validated without eyes on it, say so in one
line and hand it over with what to look for — don't reach for the browser
instead, and don't tell us to "just check the preview" in place of running the
checks above.

The browser tools stay available for the case they're actually for: executing
JavaScript, inspecting console/network output, or debugging something that
only reproduces at runtime — when the user asks for it. Use them as an
instrument, not as a test pass.

Never run a dev server through Bash (`npm run dev`, `npm run preview`,
`vite`) — foregrounded it hangs the session, backgrounded it lingers and eats
the port the human wanted. Use `preview_start` if you need a server at all.

## Token discipline

Context is the budget. Cheapest correct action wins.

- **Read narrowly.** Grep/Glob to locate, then read the specific range. Don't
  read a whole file to change one function, and never read `package-lock.json`,
  `dist/`, or anything in `node_modules/`.
- **Don't re-read what you just wrote.** Edit and Write fail loudly; a
  successful edit needs no confirmation read.
- **Batch independent calls** into one turn instead of trickling them out.
- **Don't restate the code.** No summarizing a file back to the user, no
  pasting diffs they can already see. Point at `src/lib/solver.ts:120` instead.
- **No subagents, no workflows** unless the user explicitly asks for them. A
  fresh agent re-derives everything this session already knows.
- **Batch the checks.** Run `npm run build && npm run lint` once at the end of
  a logical change, not after each edit.
- **Answer, then stop.** No preamble, no plan-recap before acting, no closing
  summary of a summary. Two or three sentences is a complete reply.
- Prefer `rg`/`grep` over `cat`. Never `cat` a file just to skim it.

## Ground rules

- Work on a feature branch, never commit directly to `main`.
- Branch naming: `yourname/short-description`.
- Keep commits small and scoped to one logical change.
- Do not rewrite git history that has been pushed.
- Do not commit secrets, `.env` files, API keys, or credentials.
- Run `npm run build` and `npm run lint` before every commit.
- Never commit `dist/` or `node_modules/` — both are gitignored, keep it so.

## Commands

```bash
npm ci            # install exactly what the lockfile says (preferred)
npm run build     # tsc -b && vite build — this is the typecheck
npm run lint      # oxlint
npm run bake      # re-fetch real road data into src/data (rarely needed)
npm run dev       # HUMANS ONLY — agents must not run this
npm run preview   # HUMANS ONLY — agents must not run this
```
