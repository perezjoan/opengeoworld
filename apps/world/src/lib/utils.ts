import { Engine, EnterSpaceOpts, CreateSpaceResult } from "@opengeoworld/engine";
import { applyPlace, type LoadedPlace } from "@/lib/place";

/** Where the world is served from (e.g. "/world" or "/opengeoworld/world"), set at build time. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export interface LoadGameOpts {
  /**
   * Base URL for the base scene and asset paths: the scene is fetched from
   * `{baseUrl}/data/scene.base.json` and "/assets/..." URLs in it are prefixed with it.
   */
  baseUrl: string;
  /** The place built by the web app, added to the base scene. */
  place?: LoadedPlace | null;
}

/**
 * Create the game space: base scene + the visitor's place.
 * Returns the Space and a reveal function for controlling intro fade timing.
 */
export async function createGame(opts: LoadGameOpts): Promise<CreateSpaceResult> {
  const { baseUrl, place } = opts;

  const res = await fetch(`${baseUrl}/data/scene.base.json`);
  let game = (await res.json()) as EnterSpaceOpts["game"];
  if (place) game = applyPlace(game as any, place) as typeof game;

  const engine = Engine.getInstance();

  return engine.createSpace({
    mode: "game",
    game,
    assets: { baseUrl, engineAssetsBase: `${baseUrl}/engine-assets` },
    userReady: Promise.resolve({ id: "visitor", name: "Visitor" }),
  });
}
