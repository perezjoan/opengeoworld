// Animated water for the place's rivers and lakes: the web app sends the water polygons (model
// frame: x east, z = -north, plus a level); we triangulate them and use a glossy physical material
// with two scrolling normal maps (the engine's generated waterNormals.jpg) and environment
// reflections. Not part of the collision mesh: the carved terrain below is the river bed.
import {
  BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshPhysicalMaterial, RepeatWrapping,
  ShapeUtils, TextureLoader, Vector2, NoColorSpace,
} from "three";

export interface WaterPolygon {
  level: number;
  outer: [number, number][];
  holes: [number, number][][];
}

export interface Water {
  object: Group;
  update(dt: number): void;
}

const TILE = 24; // metres per normal-map tile

export function createWater(polygons: WaterPolygon[], engineAssetsBase: string): Water {
  const group = new Group();
  group.name = "water";
  if (!polygons?.length) return { object: group, update() {} };

  const loader = new TextureLoader();
  const n1 = loader.load(`${engineAssetsBase}/textures/waterNormals.jpg`);
  n1.wrapS = n1.wrapT = RepeatWrapping;
  n1.colorSpace = NoColorSpace;
  const n2 = n1.clone();
  n2.repeat.set(0.6, 0.6);

  // Opaque (the riverbed under it is a stretched aerial photo, better unseen) and one soft
  // reflection layer: a strong clearcoat on a glossy base mirrored the pale sky twice and the
  // water looked white at street level.
  const material = new MeshPhysicalMaterial({
    color: 0x1f3d42,
    roughness: 0.22,
    metalness: 0,
    normalMap: n1,
    normalScale: new Vector2(0.55, 0.55),
    clearcoat: 0.35,
    clearcoatRoughness: 0.15,
    clearcoatNormalMap: n2,
    clearcoatNormalScale: new Vector2(0.35, 0.35),
    envMapIntensity: 0.45,
  });

  for (const p of polygons) {
    const contour = p.outer.map(([x, z]) => new Vector2(x, z));
    const holes = (p.holes || []).map((h) => h.map(([x, z]) => new Vector2(x, z)));
    if (contour.length < 3) continue;
    const all = [...contour, ...holes.flat()];
    const pos: number[] = [], uv: number[] = [];
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, holes)) {
      let a = all[i], b = all[j], c = all[k];
      // In the x/z plane, (b-a)×(c-a) < 0 means the triangle faces up (+Y) once mapped to 3D.
      if ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) > 0) [b, c] = [c, b];
      for (const v of [a, b, c]) { pos.push(v.x, p.level, v.y); uv.push(v.x / TILE, v.y / TILE); }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const mesh = new Mesh(g, material);
    mesh.name = "water-surface";
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  let t = 0;
  return {
    object: group,
    update(dt) {
      t += dt;
      n1.offset.set(t * 0.012, t * 0.007);
      n2.offset.set(-t * 0.009, t * 0.011);
    },
  };
}
