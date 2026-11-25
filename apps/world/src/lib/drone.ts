// A low-poly quadcopter, built in code (original work): faceted body, four arms and motors,
// spinning two-blade props with blur discs, landing skids, a camera gimbal and blinking LEDs.
// In fly mode it replaces the avatar: the physics body (capsule) still moves and collides; the
// drone just follows it, faces where the camera looks and tilts with its movement.
import {
  Group, Mesh, MeshStandardMaterial, MeshBasicMaterial, CylinderGeometry, BoxGeometry,
  SphereGeometry, CircleGeometry, Vector3, MathUtils, DoubleSide, Object3D, Color,
} from "three";

const mat = (color: number, opts: Partial<{ metalness: number; roughness: number; emissive: number }> = {}) =>
  new MeshStandardMaterial({ color, flatShading: true, metalness: opts.metalness ?? 0.1, roughness: opts.roughness ?? 0.6, emissive: opts.emissive ?? 0 });

export interface Drone {
  object: Group;
  /** Show (true) / hide (false), with a short scale-in. */
  setActive(on: boolean): void;
  /** Call every frame with the player's world position and the camera heading (radians, 0 = +Z). */
  update(dt: number, position: Vector3, heading: number): void;
}

export function createDrone(): Drone {
  const root = new Group();
  root.name = "drone";
  const body = new Group(); // tilts; root only moves and turns
  root.add(body);

  const shell = mat(0x2b2f36, { roughness: 0.45 });
  const shellLight = mat(0xd8dce2, { roughness: 0.5 });
  const accent = mat(0xff7a1a, { roughness: 0.5 });
  const metal = mat(0x6d7480, { metalness: 0.6, roughness: 0.35 });
  const dark = mat(0x15171a, { roughness: 0.7 });

  // Fuselage: octagonal, wider at the bottom, light canopy on top, battery with an orange band.
  const hull = new Mesh(new CylinderGeometry(0.17, 0.21, 0.1, 8), shell);
  hull.rotation.y = Math.PI / 8;
  body.add(hull);
  const canopy = new Mesh(new CylinderGeometry(0.11, 0.165, 0.06, 8), shellLight);
  canopy.position.y = 0.08;
  canopy.rotation.y = Math.PI / 8;
  body.add(canopy);
  const battery = new Mesh(new BoxGeometry(0.16, 0.05, 0.24), dark);
  battery.position.set(0, 0.135, -0.02);
  body.add(battery);
  const band = new Mesh(new BoxGeometry(0.165, 0.018, 0.05), accent);
  band.position.set(0, 0.145, 0.05);
  body.add(band);

  // Arms (X layout), motors, props.
  const props: { blades: Object3D; disc: Mesh; dir: number }[] = [];
  const ARM = 0.42;
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2; // 45°, 135°, 225°, 315°
    const dir = new Vector3(Math.sin(a), 0, Math.cos(a));
    const arm = new Mesh(new BoxGeometry(0.04, 0.032, ARM), shell);
    arm.position.copy(dir.clone().multiplyScalar(ARM / 2 + 0.08));
    arm.rotation.y = a;
    body.add(arm);
    const tip = dir.clone().multiplyScalar(ARM + 0.08);
    const motor = new Mesh(new CylinderGeometry(0.045, 0.05, 0.06, 8), metal);
    motor.position.set(tip.x, 0.03, tip.z);
    body.add(motor);
    const hub = new Mesh(new CylinderGeometry(0.018, 0.018, 0.03, 6), dark);
    hub.position.set(tip.x, 0.075, tip.z);
    body.add(hub);
    const blades = new Group();
    blades.position.set(tip.x, 0.085, tip.z);
    for (const s of [0, Math.PI]) {
      const blade = new Mesh(new BoxGeometry(0.3, 0.006, 0.035), i % 2 ? shellLight : dark);
      blade.position.x = 0.15 * Math.cos(s);
      blade.rotation.set(0.12 * (s ? -1 : 1), s, 0);
      blades.add(blade);
    }
    body.add(blades);
    const disc = new Mesh(new CircleGeometry(0.3, 16), new MeshBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.0, side: DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(tip.x, 0.088, tip.z);
    body.add(disc);
    props.push({ blades, disc, dir: i % 2 ? 1 : -1 });
  }

  // Skids
  for (const s of [-1, 1]) {
    const leg1 = new Mesh(new BoxGeometry(0.02, 0.12, 0.02), dark);
    leg1.position.set(0.11 * s, -0.1, 0.07);
    const leg2 = leg1.clone();
    leg2.position.z = -0.07;
    const skid = new Mesh(new CylinderGeometry(0.012, 0.012, 0.3, 6), dark);
    skid.rotation.x = Math.PI / 2;
    skid.position.set(0.11 * s, -0.16, 0);
    body.add(leg1, leg2, skid);
  }

  // Camera gimbal at the front, under the hull.
  const gimbal = new Mesh(new SphereGeometry(0.05, 8, 6), dark);
  gimbal.position.set(0, -0.06, 0.15);
  body.add(gimbal);
  const lens = new Mesh(new CylinderGeometry(0.022, 0.022, 0.02, 8), mat(0x223355, { metalness: 0.8, roughness: 0.15 }));
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, -0.06, 0.2);
  body.add(lens);

  // LEDs: white/green at the front arms, red at the back, blinking.
  const leds: { m: MeshBasicMaterial; base: Color; phase: number }[] = [];
  for (const [x, z, color, phase] of [[0.32, 0.32, 0x7dff9a, 0], [-0.32, 0.32, 0xffffff, 0], [0.32, -0.32, 0xff3333, 0.5], [-0.32, -0.32, 0xff3333, 0.5]] as const) {
    const m = new MeshBasicMaterial({ color });
    const led = new Mesh(new SphereGeometry(0.018, 6, 4), m);
    led.position.set(x, -0.01, z);
    body.add(led);
    leds.push({ m, base: new Color(color), phase });
  }

  // The whole drone is ~1.1 m across: readable from the third-person camera.
  body.scale.setScalar(1.15);
  root.visible = false;

  let active = false, appear = 0, time = 0;
  const last = new Vector3(), vel = new Vector3(), local = new Vector3();
  let hasLast = false, yaw = 0, pitch = 0, roll = 0;

  return {
    object: root,
    setActive(on) {
      active = on;
      if (on) { root.visible = true; appear = 0; hasLast = false; }
    },
    update(dt, position, heading) {
      time += dt;
      appear = MathUtils.clamp(appear + (active ? dt : -dt) * 5, 0, 1);
      if (!active && appear === 0) { root.visible = false; return; }
      const k = appear * appear * (3 - 2 * appear);
      root.scale.setScalar(Math.max(0.001, k));

      // Hover at the capsule's centre, with a gentle bob.
      root.position.copy(position);
      root.position.y += 0.9 + Math.sin(time * 2.3) * 0.03;

      // Velocity from the position change (m/s), smoothed.
      if (hasLast && dt > 0) vel.lerp(local.copy(position).sub(last).divideScalar(dt), Math.min(1, dt * 6));
      last.copy(position);
      hasLast = true;

      // Face the camera's direction (smoothly), tilt into the movement like a real quad.
      let dy = heading - yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      yaw += dy * Math.min(1, dt * 6);
      root.rotation.y = yaw;
      local.copy(vel).applyAxisAngle(new Vector3(0, 1, 0), -yaw); // velocity in the drone's frame
      const tp = MathUtils.clamp(local.z / 40, -1, 1) * 0.42; // forward speed → nose down
      const tr = MathUtils.clamp(local.x / 40, -1, 1) * 0.42; // sideways → bank
      pitch += (tp - pitch) * Math.min(1, dt * 5);
      roll += (-tr - roll) * Math.min(1, dt * 5);
      body.rotation.set(pitch, 0, roll);

      // Props: very fast spin + motion-blur discs; faster when moving or climbing.
      const speed = 55 + Math.min(60, vel.length() * 1.5);
      for (const p of props) {
        p.blades.rotation.y += p.dir * speed * dt;
        (p.disc.material as MeshBasicMaterial).opacity = 0.18 * k;
      }
      for (const l of leds) l.m.color.copy(l.base).multiplyScalar((time + l.phase) % 1 < 0.15 ? 1 : 0.25); // blink
    },
  };
}
