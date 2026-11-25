import type { NextConfig } from "next";

// The world is exported as static files and served from `<site base>/world/`, next to the web app.
// OGW_BASE_PATH is the folder the site lives in on the web server ("" for the domain root,
// "/opengeoworld" for https://example.com/opengeoworld/). Set it when building.
const sitePath = (process.env.OGW_BASE_PATH ?? "").replace(/\/+$/, "");
const basePath = `${sitePath}/world`;

const compiler: NextConfig["compiler"] =
  process.env.NODE_ENV === "production"
    ? {
        removeConsole: {
          exclude: ["error", "warn"],
        },
      }
    : undefined;

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true, // world/ -> world/index.html on plain static hosting (Apache, OVH)
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  transpilePackages: ["@opengeoworld/engine"],
  compiler,
};

export default nextConfig;
