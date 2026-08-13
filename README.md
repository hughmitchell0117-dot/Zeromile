# ZeroMile

> **Rev. 002 — the redesign.** Same engine, new skin. The solver, the OSRM
> road data, the map, the demo console and the driver phone are carried over
> unchanged from Rev. 001; the page shell and the design system were rebuilt as
> a printed dispatch sheet — paper stock, ruled sections, one signal colour, no
> glow. See [Design layers](#design-layers).

ZeroMile — a pitch site and live simulator for chained freight dispatch in
Korea. React + TypeScript + Vite; the solver runs entirely in the browser, so
there is no backend, no database, no `.env`, and no API keys to obtain.

One thing it *does* need: **an internet connection**, for the map's basemap
tiles. See [The map and the road data](#the-map-and-the-road-data).

Shared project: two collaborators, two machines, two different AI coding tools
(Claude Code and Codex). The rules below keep the history clean.

---

## Run it locally

You need **Node 20 or newer** (we're on 24 — see `.nvmrc`). Check with
`node -v`. If yours is older, install via [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install && nvm use
```

Then, from the repo root:

```bash
npm ci
```

```bash
npm run dev
```

Vite prints a `http://localhost:5173` URL — open it. Hot reload is on, so just
save and the page updates.

Use `npm ci`, not `npm install`, unless you're deliberately adding a
dependency. `ci` installs exactly what `package-lock.json` says, which is why
your machine and mine behave the same. `install` can quietly bump versions and
dirty the lockfile.

### When it doesn't run

**`Port 5173 is already in use`** — something else (often an old dev server, or
the other collaborator's project) has it. Pick another port:

```bash
npm run dev -- --port 5180
```

Or kill whatever is squatting on it:

```bash
lsof -ti:5173 | xargs kill
```

**`command not found: npm` / wrong Node version** — you're on a shell that
didn't pick up nvm. Run `nvm use` in that terminal first.

**`Cannot find module` or weird type errors right after a `git pull`** — the
lockfile moved. Reinstall:

```bash
npm ci
```

**Still broken? Nuke and repave.** This is safe — nothing here is precious:

```bash
rm -rf node_modules dist && npm ci
```

**The page loads but is blank** — open the browser devtools console. It's
almost always a React error printed there, not a build problem.

**The page loads but the map area is black** — you're offline, or the tile host
is down. The rest of the page works fine without tiles; only the map goes dark.
Check the Network tab for requests to `tiles.openfreemap.org`.

### Other commands

```bash
npm run build     # tsc -b && vite build — typechecks AND bundles
npm run lint      # oxlint
npm run preview   # serve the built output from dist/ (run build first)
npm run bake      # re-fetch the road data — you almost certainly don't need this
```

There is no test suite. `npm run build` is the typecheck, and it's the check
that matters before you commit.

---

## The map and the road data

The map is a real one, and the distances behind it are real. Worth knowing
before you touch either.

**The basemap** is [MapLibre GL](https://maplibre.org) rendering
[OpenFreeMap](https://openfreemap.org)'s dark OpenStreetMap vector tiles. No
account, no API key, no usage ceiling — but it is fetched over the network at
runtime, so **the map needs an internet connection**. Offline, the freight
lines still draw on a black background.

**The distances and route shapes** are not fetched at runtime. They're routed
once with [OSRM](https://project-osrm.org) over OpenStreetMap and committed to
`src/data`:

| file | what it is |
| --- | --- |
| `sites.json` | 75×75 driving distance + duration matrix between every dock |
| `cities.json` | the same, city to city, for the planner UI |
| `routes.json` | 435 city-pair route polylines, for drawing the corridors |

Every kilometre and drive-time in the app reads from those. Nothing routes at
runtime, so the site works with no routing service and no keys.

### Re-baking

**You almost never need this.** Only re-run it if you change the docks in
`src/lib/sites.ts` or the city list in `src/lib/geo.ts`:

```bash
npm run bake
```

It hits OSRM's **public demo server**, so be considerate: it paces itself at
one request per 650ms and takes about five minutes. It's resumable — a re-run
only fetches what's missing from `routes.json`. Don't loop it, and don't remove
the pacing.

Map data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
Attribution is displayed on the map and must stay there.

### If you're changing the map

Two non-obvious things that will cost you an afternoon otherwise:

- MapLibre parses tiles in a web worker that it locates via
  `new URL(..., import.meta.url)`. Vite mangles that, and the symptom is a
  totally blank map with no console error. `KoreaMap.tsx` works around it with
  `?worker&url` + `setWorkerUrl` — there's a comment explaining it. Don't
  remove it.
- Add layers on the map's **`style.load`** event, not `load`. `load` also waits
  on a raster source in the basemap style that never resolves, so anything
  gated on it never runs.

---

## Committing without friction

The whole loop, start to finish:

```bash
git switch main && git pull
```

```bash
git switch -c yourname/what-youre-doing
```

...make your changes, then **before every commit**:

```bash
npm run build && npm run lint
```

If either fails, fix it now. A red build on a shared branch costs the other
person an hour of confusion.

```bash
git add -A && git commit -m "feat: short description of the change"
```

```bash
git push -u origin yourname/what-youre-doing
```

```bash
gh pr create --fill
```

After the first push, later commits on the same branch are just `git push`.

### Commit messages

`type: what changed`, present tense, lowercase. Types we use: `feat`, `fix`,
`refactor`, `style`, `docs`, `chore`.

```
feat: add depot return leg to solver scoring
fix: stop map markers drifting on window resize
```

### Rules that aren't negotiable

1. **Never commit straight to `main`.** Always branch first.
2. **Pull before you start**, every session. Merging a day-old branch is where
   the pain comes from.
3. **Small, frequent commits.** Far easier to untangle when two AI agents have
   touched the same file.
4. **Push a branch and open a PR** — don't merge locally into `main`.
5. **Don't rewrite pushed history** (`--force`, rebasing shared branches). To
   undo something on `main`, use `git revert`.
6. **Never commit `node_modules/`, `dist/`, or any `.env` file.** They're
   gitignored; if you see them in `git status`, something's wrong — stop and
   ask before committing.
7. **Do commit `src/data/*.json`.** It looks like build output but isn't —
   it's the baked road data, and the app won't run without it.

### Conflict etiquette

Agree on who owns which files before starting parallel work. If you both need
the same file, do it sequentially. Merging two AI-generated rewrites of the
same file is the single worst thing that can happen to this repo.

---

## Working with AI agents here

`AGENTS.md` (symlinked as `CLAUDE.md`) holds the instructions both Claude Code
and Codex read. It tells them to keep context usage low and **not to test with
browser use** — all visual checking is done by us, by hand. They can still open
a browser to run JS or read console errors when asked; they just don't get to
call that a test. `.claude/settings.json` blocks agents from starting dev
servers through Bash, where they hang or squat on ports.

If you change how the project is built or run, update `AGENTS.md` in the same
commit.


---

## Design layers

Two stylesheets, loaded in order by `src/main.tsx`:

1. `src/index.css` — the original design system. It still owns every internal
   component: the demo console, the map overlays, the driver phone, the 3D
   loader. It is token-driven, so it re-skins rather than fights.
2. `src/styles/redesign.css` — the redesign layer. It (a) re-tokenises the
   system above — palette, radii, type — and (b) owns the page shell, every
   class prefixed `zm-`.

Paper (light) is the default theme; carbon (dark) is the alternate, and the
masthead toggle flips `<html data-theme>`. MapLibre swaps basemaps off the same
attribute, so `KoreaMap` is keyed on the theme and remounts on a flip.

House rules for the new skin: no glow, no bloom, no blurred drop shadows.
Depth comes from hard rules and flat offset blocks, the way ink on paper does
it. Radii are zero. Data is always mono.
