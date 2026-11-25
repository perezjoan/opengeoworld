# @opengeoworld/world

The walkable world: a Next.js app on `@opengeoworld/engine`, exported as static files
(`output: "export"`, served under `<site base>/world/`).

- `src/lib/place.ts`: reads the place the web app saved in IndexedDB and adds it to
  `public/data/scene.base.json` (walkable mesh collider, avatar spawn, base terrain moved under it).
- `src/lib/game-script.ts`: player controls (walk, jump, sprint, fly mode on F), camera, and the
  position messages sent to the embedding page for the minimap.
- `src/components/game-ui.tsx`: start screen, pause, fly-mode badge.

Normally run through the repo root (`npx -y pnpm@10.10.0 dev` / `build`). The base path comes from
`OGW_BASE_PATH` at build time (see the root README).
