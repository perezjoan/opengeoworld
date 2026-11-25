# Photo facade library

Photo-real tiles for building walls, shopfronts and roofs, used by `src/facades.js`. Every picture here was generated for opengeoworld with an open-weights image model (Qwen-Image-Edit-2511, Apache-2.0); none is a photo of a real building and none comes from a third-party texture site. Like the rest of the repository they are released under the MIT licence, and you may also use them under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): no attribution needed.

| Files | What | Tile |
|---|---|---|
| `stone-*`, `render-*`, `brick-*`, `modern-*`, `concrete-*`, `industrial-*` | wall styles, several variants each | one window bay × one storey, seamless both ways; the window is centred and the tile starts at the floor line |
| `house-render-*`, `house-brick-*`, `house-stone-*`, `house-wood-*` | single-family houses (and their garages), by wall material | one window bay × one storey, like the walls; `material` in library.json lets a brick house get a brick tile |
| `shop-*` | ground-floor shopfronts | one shopfront × the ground floor (pavement to the top of the sign band), seamless across |
| `roof-tiles`, `roof-slate`, `roof-zinc`, `roof-flat` | roof coverings seen from above | seamless both ways; on pitched roofs the picture's vertical runs down the slope |

All tiles are 512 × 512 JPEG; the real proportions are in `library.json`:

```json
{
  "storey_m": 3,
  "walls": { "stone": [{ "file": "stone-1.jpg", "aspect": 0.91, "mean": "#e2d8c6" }] },
  "shops": [{ "file": "shop-1.jpg", "aspect": 1.5, "mean": "#5d5248" }],
  "roofs": { "tiles": { "file": "roof-tiles.jpg", "metres": 2.5, "mean": "#a85a3c" } }
}
```

- `aspect`: width / height of the tile in reality. A wall tile is `aspect × 3 m` wide for a 3 m storey (the mesh stretches it to the building's real storey height); a shop tile is `aspect × 4.2 m` wide.
- `mean`: the tile's average colour. A building with a known colour (OSM `building:colour`, `roof:colour`) gets the variant closest to it, tinted a little further towards it.
- `metres`: size of one roof texture repeat.

## Adding a tile

Any 512 × 512 JPEG that follows the rules in the table works: put it here and add an entry to `library.json` (the style names are the keys `facades.js` knows: `stone`, `render`, `brick`, `modern`, `concrete`, `industrial`, `house`). For a wall, cut exactly one bay wide and one storey high from a straight-on (orthographic) picture, and blend the edges so it repeats without a seam.

How these were made: a prompt per style asked for a strictly regular, perfectly frontal elevation; the bay and storey sizes were found from the repeat of the image's gradients (autocorrelation); the tile was cut in the middle of the plain wall between two storeys, centred on a window, and its edges were cross-faded with the next bay/storey.
