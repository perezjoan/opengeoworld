import assetsJSON from "./assets.json";
import { AssetResolver } from "../../assets/asset-resolver";

type AssetsJSON = typeof assetsJSON;

type Scope = keyof AssetsJSON;

export interface ImageOpts {
    id: string;
    image: string;
    path: string;
}

/**
 * Recursively resolve all URL strings in an object through AssetResolver.
 */
function resolveUrls<T>(obj: T): T {
    if (typeof obj === "string") {
        return AssetResolver.resolveEngineAsset(obj) as T;
    }
    if (Array.isArray(obj)) {
        return obj.map(resolveUrls) as T;
    }
    if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(obj)) {
            result[key] = resolveUrls((obj as Record<string, unknown>)[key]);
        }
        return result as T;
    }
    return obj;
}

class AssetsManager {
    //
    constructor() {
        //
        // Where the engine-assets folder is served (e.g. "/my-site/world/engine-assets"), set
        // by the host page before the engine loads. Without it: "/engine-assets".
        const base = (globalThis as any).$engineAssetsBase;
        if (typeof base === "string" && base) {
            AssetResolver.configure({ ...AssetResolver.getConfig(), engineAssetsBase: base.replace(/\/+$/, "") });
        }

        const json = (globalThis as any).$engineAssets || assetsJSON;

        this._setJSON(json);
    }

    private _setJSON(json: typeof assetsJSON) {
        //
        const resolved = resolveUrls(json);
        Object.assign(this, resolved);
    }

    getImageOpt<S extends Scope>(scope: S, obj: ImageOpts): ImageOpts {
        //
        return (this as any)[scope]?.[obj?.id] || obj;
    }
}

export const Assets: Readonly<AssetsManager & typeof assetsJSON> =
    new AssetsManager() as any;
