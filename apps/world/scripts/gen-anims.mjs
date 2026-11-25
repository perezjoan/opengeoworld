// Generates the avatar animations of opengeoworld, keyframed in code (original work, no motion
// capture): idle, walk, run, sprint, jump, double jump, falling, landing, fly (hover), sitting.
//
//   node apps/world/scripts/gen-anims.mjs
//
// Output (three.js AnimationClip JSON, the format the engine loads):
//   public/engine-assets/jsons/defaultAnims.json   { idle, walk, run, jump, fly, sitting }
//   public/assets/anims/<name>.json                 the clips named in data/scene.base.json
//
// How the engine reads them (packages/engine/.../load-mixamo-animation.js): track names use the
// Mixamo bone names, quaternions are applied directly to the VRM's *normalized* bones (identity
// rotation = T-pose, VRM 1.0 frame: Y up, facing +Z, character's left = +X), and the hips
// position is scaled by (avatar hips height / 96.7448), the Mixamo reference hips height.
//
// Rotation conventions in that frame (handy when tweaking):
//   thigh / arm swing around X: negative = forward      knee bend: +X     elbow bend: -Y left, +Y right
//   spine/head around X: positive = lean forward / look down     yaw around Y: positive = turn left
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Quaternion, Vector3 } from 'three';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MOTION_HIPS = 96.7448; // Mixamo reference hips height (engine baserig.json)
const FPS = 30;
const deg = Math.PI / 180;

const MIXAMO = {
  hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
};

const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0), Z = new Vector3(0, 0, 1);
const qa = (axis, a) => new Quaternion().setFromAxisAngle(axis, a * deg);
/** q1 * q2 * … : the rightmost rotation is applied first. */
const mul = (...qs) => qs.reduce((acc, q) => acc.multiply(q), new Quaternion());
const rot = ({ x = 0, y = 0, z = 0 } = {}) => mul(qa(Y, y), qa(X, x), qa(Z, z));

/**
 * Arm pose. down: how far the arm is lowered from the T-pose (90 = hanging), swing: around X after
 * lowering (negative = forward), elbow: forearm bend (positive = flex, hand comes forward).
 */
function arm(side, { down = 75, swing = 0, out = 0, elbow = 10, wrist = 0 }) {
  const s = side === 'left' ? 1 : -1;
  return {
    [`${side}UpperArm`]: mul(qa(X, swing), qa(Y, out * s), qa(Z, -down * s)),
    [`${side}LowerArm`]: qa(Y, -elbow * s),
    [`${side}Hand`]: qa(Z, -wrist * s),
  };
}
function leg(side, { thigh = 0, knee = 0, foot = 0, splay = 0, toes = 0 }) {
  const s = side === 'left' ? 1 : -1;
  return {
    [`${side}UpperLeg`]: mul(qa(Z, splay * s), qa(X, thigh)),
    [`${side}LowerLeg`]: qa(X, knee),
    [`${side}Foot`]: qa(X, foot),
    [`${side}Toes`]: qa(X, toes),
  };
}

/** Build a clip by sampling pose(t) → { hips:[x,y,z] (fraction of hips height for y), bones:{name: Quaternion} }. */
function clip(name, duration, pose) {
  const n = Math.max(2, Math.round(duration * FPS));
  const times = [], tracks = {};
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration;
    times.push(+t.toFixed(4));
    const p = pose(t, t / duration);
    const hp = p.hips ?? [0, 1, 0];
    (tracks['Hips.position'] ||= []).push(+(hp[0] * 100).toFixed(3), +(hp[1] * MOTION_HIPS).toFixed(3), +(hp[2] * 100).toFixed(3));
    for (const bn of Object.keys(MIXAMO)) {
      const q = p.bones[bn] ?? new Quaternion();
      (tracks[`${MIXAMO[bn]}.quaternion`] ||= []).push(...q.normalize().toArray().map((x) => +x.toFixed(5)));
    }
  }
  return {
    name, duration, blendMode: 2500, uuid: `ogw-${name}`,
    tracks: Object.entries(tracks).map(([k, values]) => ({
      name: `mixamorig${k}`, times, values, type: k.endsWith('position') ? 'vector' : 'quaternion',
    })),
  };
}

const TAU = Math.PI * 2;
const pos = (x) => Math.max(0, x);

// ---------------------------------------------------------------- cycles
/** Shared gait: walk (r=0) → run (r=1) → sprint (r=1.25). ph = 0..1 over one cycle (two steps). */
function gait(r) {
  const run = Math.min(1, r);
  return (t, ph) => {
    const a = ph * TAU, s = Math.sin(a), c = Math.cos(a);
    const thighAmp = 24 + 22 * run + 10 * (r - run) * 4; // walk 24°, run 46°, sprint ~56°
    const kneeSwing = 50 + 50 * run + 15 * (r - run) * 4; // peak knee flex in swing
    const lean = 3 + 9 * run + 6 * (r - run) * 4;
    const legL = { thigh: -thighAmp * s - 4 * run, knee: 4 + 8 * run + kneeSwing * pos(Math.cos(a - 0.35)) ** 1.6, foot: -6 + 18 * pos(Math.cos(a + 0.9)) - 6 * run * pos(-s) };
    const legR = { thigh: thighAmp * s - 4 * run, knee: 4 + 8 * run + kneeSwing * pos(Math.cos(a + Math.PI - 0.35)) ** 1.6, foot: -6 + 18 * pos(Math.cos(a + Math.PI + 0.9)) - 6 * run * pos(s) };
    const armAmp = 18 + 26 * run;
    const elbow = 14 + 70 * run;
    // Walking: highest at mid-stance (inverted pendulum). Running: lowest at mid-stance.
    const bob = run > 0.5 ? -0.03 * Math.cos(2 * a) : 0.012 * Math.cos(2 * a);
    const crouch = run > 0.5 ? -0.035 : -0.005;
    const yaw = 7 * s * (0.6 + 0.4 * run);
    return {
      hips: [0.008 * s * (1 - run), 1 + crouch + bob, 0],
      bones: {
        hips: rot({ x: lean * 0.45, y: -yaw }),
        spine: rot({ x: lean * 0.3, y: yaw * 0.5 }),
        chest: rot({ x: lean * 0.25, y: yaw * 0.5 }),
        upperChest: rot({ y: yaw * 0.4 }),
        neck: rot({ x: -lean * 0.3 }),
        head: rot({ x: -lean * 0.55, y: -yaw * 0.4 }),
        ...leg('left', legL), ...leg('right', legR),
        ...arm('left', { down: 74 - 4 * run, swing: armAmp * s - 4, elbow: elbow - 12 * s * run }),
        ...arm('right', { down: 74 - 4 * run, swing: -armAmp * s - 4, elbow: elbow + 12 * s * run }),
      },
    };
  };
}

function idle(t, ph) {
  const a = ph * TAU, br = Math.sin(a * 2); // two breaths per loop
  return {
    hips: [0.006 * Math.sin(a), 1 - 0.002 + 0.002 * br, 0],
    bones: {
      hips: rot({ z: 1.2 * Math.sin(a), y: 1.5 * Math.sin(a) }),
      spine: rot({ x: 1 + 0.6 * br, z: -0.8 * Math.sin(a) }),
      chest: rot({ x: -0.8 * br }),
      upperChest: rot({ x: -0.5 * br }),
      neck: rot({ x: 1 }),
      head: rot({ x: -1 + 1.2 * Math.sin(a * 2 + 1), y: 4 * Math.sin(a + 0.6) }),
      ...leg('left', { thigh: -2, knee: 3, foot: -1, splay: 2 }),
      ...leg('right', { thigh: 1, knee: 1, foot: 0, splay: 3 }),
      ...arm('left', { down: 80 - 1.5 * br, swing: -3, elbow: 10, wrist: 4 }),
      ...arm('right', { down: 80 - 1.5 * br, swing: -3, elbow: 10, wrist: 4 }),
    },
  };
}

/** Airborne after a jump: knees up, arms raised a bit. Gentle motion so it can loop. */
function jumpPose(intensity = 1, spin = 0) {
  return (t, ph) => {
    const a = ph * TAU, w = Math.sin(a);
    return {
      hips: [0, 1, 0],
      bones: {
        hips: rot({ x: -4 * intensity, y: spin ? 360 * ph : 0 }),
        spine: rot({ x: 6 * intensity }),
        chest: rot({ x: 4 }),
        head: rot({ x: -6 }),
        ...leg('left', { thigh: -50 * intensity + 4 * w, knee: 70 * intensity - 6 * w, foot: 15 }),
        ...leg('right', { thigh: -25 * intensity - 4 * w, knee: 45 * intensity + 6 * w, foot: 15 }),
        ...arm('left', { down: 50 + 6 * w, swing: -40, elbow: 40 }),
        ...arm('right', { down: 55 - 6 * w, swing: -20, elbow: 40 }),
      },
    };
  };
}

function falling(t, ph) {
  const a = ph * TAU, s = Math.sin(a), s2 = Math.sin(2 * a);
  return {
    hips: [0, 1, 0],
    bones: {
      spine: rot({ x: -6 }),
      chest: rot({ x: -3 }),
      head: rot({ x: 8 + 2 * s2 }),
      ...leg('left', { thigh: -32 + 8 * s, knee: 48 - 10 * s, foot: 18 }),
      ...leg('right', { thigh: -12 - 8 * s, knee: 26 + 10 * s, foot: 18 }),
      ...arm('left', { down: 58 + 8 * s2, swing: -22 + 6 * s, elbow: 38, out: 14 }),
      ...arm('right', { down: 58 - 8 * s2, swing: -22 - 6 * s, elbow: 38, out: 14 }),
    },
  };
}

/** Landing: absorb (crouch) then stand up. Not cyclic: 0 → deep → up. */
function landing(depth = 1, roll = false) {
  return (t, ph) => {
    const k = Math.sin(Math.min(1, ph / 0.75) * Math.PI) ** 1.2; // 0 → 1 → 0
    const d = k * depth;
    return {
      hips: [0, 1 - 0.16 * d, 0.02 * d],
      bones: {
        hips: rot({ x: 18 * d }),
        spine: rot({ x: 14 * d + (roll ? 25 * k : 0) }),
        chest: rot({ x: 6 * d }),
        head: rot({ x: -20 * d }),
        ...leg('left', { thigh: -55 * d, knee: 85 * d, foot: -30 * d }),
        ...leg('right', { thigh: -50 * d, knee: 80 * d, foot: -28 * d }),
        ...arm('left', { down: 70 - 25 * d, swing: -30 * d, elbow: 20 + 20 * d }),
        ...arm('right', { down: 70 - 25 * d, swing: -30 * d, elbow: 20 + 20 * d }),
      },
    };
  };
}

function hover(t, ph) {
  const a = ph * TAU, s = Math.sin(a);
  return {
    hips: [0, 1 + 0.01 * s, 0],
    bones: {
      spine: rot({ x: 2 }),
      head: rot({ x: -2 }),
      ...leg('left', { thigh: -8, knee: 18 + 4 * s, foot: 25 }),
      ...leg('right', { thigh: -4, knee: 22 - 4 * s, foot: 25 }),
      ...arm('left', { down: 45 + 4 * s, swing: -5, elbow: 15, out: 5 }),
      ...arm('right', { down: 45 + 4 * s, swing: -5, elbow: 15, out: 5 }),
    },
  };
}

function sitting(t, ph) {
  const br = Math.sin(ph * TAU * 2);
  return {
    hips: [0, 0.56, 0.08],
    bones: {
      spine: rot({ x: -4 + 0.6 * br }),
      chest: rot({ x: 2 }),
      head: rot({ x: 4 }),
      ...leg('left', { thigh: -88, knee: 92, foot: -4, splay: 4 }),
      ...leg('right', { thigh: -86, knee: 88, foot: -4, splay: 5 }),
      ...arm('left', { down: 78, swing: -38, elbow: 48 }),
      ...arm('right', { down: 78, swing: -38, elbow: 48 }),
    },
  };
}

// ---------------------------------------------------------------- write
const C = {
  idle: clip('idle', 3.2, idle),
  walk: clip('walk', 1.1, gait(0)),
  run: clip('run', 0.66, gait(1)),
  sprint: clip('sprint', 0.54, gait(1.25)),
  jump: clip('jump', 0.8, jumpPose(1)),
  jumpDouble: clip('jump_double', 0.6, jumpPose(1.1, true)),
  falling: clip('falling', 1.2, falling),
  land: clip('land', 0.45, landing(0.6)),
  landHard: clip('land_hard', 0.55, landing(1)),
  landRoll: clip('land_roll', 0.6, landing(1, true)),
  fly: clip('fly', 2.4, hover),
  sitting: clip('sitting', 4, sitting),
};

const write = (rel, obj) => {
  const p = join(PUBLIC, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
};

write('engine-assets/jsons/defaultAnims.json', { idle: C.idle, walk: C.walk, run: C.run, jump: C.jump, fly: C.fly, sitting: C.sitting });

const files = {
  idle: C.idle, walk: C.walk, run: C.run, sprint: C.sprint,
  jump_idle: C.jump, jump_walking: C.jump, jump_running: C.jump, jump_sprinting: C.jump, jump_double: C.jumpDouble,
  falling: C.falling,
  drop_idle: C.land, drop_walking: C.land, drop_running: C.landHard, drop_sprinting: C.landHard,
  drop_walking_roll: C.landRoll, drop_running_roll: C.landRoll, drop_sprinting_roll: C.landRoll,
};
for (const [name, c] of Object.entries(files)) write(`assets/anims/${name}.json`, { ...c, name });
console.log(`wrote defaultAnims.json + ${Object.keys(files).length} clips (${Object.keys(C).length} distinct motions)`);
