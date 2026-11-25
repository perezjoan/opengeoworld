import {
  Camera,
  type Space,
  AvatarComponent,
  createInputs,
  Keyboard,
  Gamepad,
  Mouse,
  Touch,
  Custom,
  Interactions,
  Processors,
  withProcessors,
} from "@opengeoworld/engine";
import {
  Mover,
  ThirdPersonCameraRig,
  createMoverAnimStateMachine,
} from "@opengeoworld/engine/controls";
import type { MoverAnimLocomotionState } from "@opengeoworld/engine/controls";
import { Vector3 } from "three";
import { createDrone, type Drone } from "@/lib/drone";
import { createWater, type Water } from "@/lib/water";
import { createGame, BASE_PATH } from "@/lib/utils";
import { loadCurrentPlace } from "@/lib/place";
import { gameStore, setStarted, setPaused, setFlying } from "@/lib/game-store";

// --- Input definitions ---
const GAMEPLAY_INPUTS = {
  Move: {
    type: "vector2" as const,
    bindings: [
      Keyboard.wasd(),
      Keyboard.arrows(),
      Gamepad.leftStick(),
      Gamepad.dpad(),
      Touch.joystick(),
    ],
  },
  Look: {
    type: "vector2" as const,
    bindings: [
      Mouse.pointerLockDelta(),
      withProcessors(Touch.delta(), Processors.scaleVector2(-1)),
      Gamepad.rightStick(),
    ],
  },
  Zoom: {
    type: "value" as const,
    bindings: [Mouse.wheel()],
  },
  Jump: {
    type: "button" as const,
    bindings: [
      Keyboard.button("Space"),
      Gamepad.button("A"),
      Custom.button("jump"),
    ],
    interactions: [Interactions.press()],
  },
  // On foot Shift sprints; while flying it descends (and Space climbs).
  Sprint: {
    type: "button" as const,
    bindings: [
      Keyboard.button("ShiftLeft"),
      Keyboard.button("ShiftRight"),
      Gamepad.button("LB"),
      Custom.button("down"), // touch: the drone's Down button
    ],
  },
  ToggleFly: {
    type: "button" as const,
    bindings: [Keyboard.button("KeyF"), Keyboard.button("KeyK"), Gamepad.button("Y"), Custom.button("fly")],
    interactions: [Interactions.press()],
  },
} as const;

// --- Animation clip names ---
const ANIMS = {
  idle: "idle",
  walk: "walk",
  run: "run",
  sprint: "sprint",
  jump_idle: "jump_idle",
  jump_walking: "jump_walking",
  jump_running: "jump_running",
  jump_sprinting: "jump_sprinting",
  jump_double: "jump_double",
  falling: "falling",
  drop_idle: "drop_idle",
  drop_walking: "drop_walking",
  drop_walking_roll: "drop_walking_roll",
  drop_running: "drop_running",
  drop_running_roll: "drop_running_roll",
  drop_sprinting: "drop_sprinting",
  drop_sprinting_roll: "drop_sprinting_roll",
};

function getJumpClip(state: MoverAnimLocomotionState): string {
  switch (state) {
    case "walk":
      return ANIMS.jump_walking;
    case "run":
      return ANIMS.jump_running;
    case "sprint":
      return ANIMS.jump_sprinting;
    default:
      return ANIMS.jump_idle;
  }
}

function getLandingClip(
  state: MoverAnimLocomotionState,
  velocityY: number,
): string {
  const roll = velocityY < -0.6;
  switch (state) {
    case "walk":
      return roll ? ANIMS.drop_walking_roll : ANIMS.drop_walking;
    case "run":
      return roll ? ANIMS.drop_running_roll : ANIMS.drop_running;
    case "sprint":
      return roll ? ANIMS.drop_sprinting_roll : ANIMS.drop_sprinting;
    default:
      return ANIMS.drop_idle;
  }
}

// --- Movement tuning ---
const SPEED = 15;
const SPRINT_BOOST = 1.5;
const GRAVITY = -1.81;
/** Horizontal speed multiplier while flying. */
const FLY_BOOST = 2.5;
/** Climb / descend speed while flying (same per-step units as the mover's x/z). */
const FLY_VERTICAL_SPEED = 14;
/** Near zero while flying so the camera keeps up vertically (rig default 0.17). */
const CAMERA_ALTITUDE_SMOOTHING = 0.17;
const FLYING_ALTITUDE_SMOOTHING = 0.01;
/** Drone camera: distance behind the drone, and the initial downward tilt for the overview. */
const DRONE_CAMERA_DISTANCE = 16;
// Polar angle of the overview camera (0 = straight above the drone, PI/2 = level).
const DRONE_START_PHI = 0.95;
/** How often the player position is posted to an embedding page (minimap), in seconds. */
const POSITION_POST_INTERVAL = 0.1;

// Module-level reference for external control
let scriptInstance: GameScript | null = null;

export function startGame() {
  scriptInstance?.start();
}

export function togglePause() {
  scriptInstance?.togglePause();
}

/** Drone <-> on foot (F on a keyboard): the touch HUD's Fly / Land button. */
export function toggleFlying() {
  scriptInstance?.toggleFlying();
}

export class GameScript {
  private space: Space | null = null;
  private cleanup: (() => void) | null = null;
  private _player: AvatarComponent | null = null;

  // Control primitives
  private inputs: ReturnType<typeof createInputs<typeof GAMEPLAY_INPUTS>> | null = null;
  private cameraRig: ThirdPersonCameraRig | null = null;
  private mover: Mover | null = null;
  private animStateMachine: ReturnType<typeof createMoverAnimStateMachine> | null = null;
  private controlsActive = false;
  private flying = false;
  private postTimer = 0;
  private drone: Drone | null = null;
  private water: Water | null = null;
  private startInDrone = false;
  private overviewDone = false;
  private holdStart: { position: Vector3; steps: number } | null = null;

  /**
   * Initialize the game scene.
   * Returns when space is fully loaded and ready.
   */
  async init() {
    scriptInstance = this;
    // Development only: inspect the running game from the console (window.__ogw).
    if (process.env.NODE_ENV !== "production") (globalThis as any).__ogw = this;

    // Create space - returns when fully loaded
    // The place built by the web app (IndexedDB, same site); without one, just the base scene.
    const place = await loadCurrentPlace();
    if (!place) console.info("[world] no place saved yet: build one in the web app first");
    const { space, reveal } = await createGame({ baseUrl: BASE_PATH, place });
    this.space = space;

    // Components are immediately available after await
    this._player = this.space.components.byId("player") as AvatarComponent;

    if (!this._player) {
      console.warn("[Game] Player avatar not found");
      return;
    }

    // Input system
    this.inputs = createInputs(GAMEPLAY_INPUTS);

    // Drone for fly mode (hidden until F)
    this.drone = createDrone();
    this.space.add(this.drone.object);

    // Animated water for the place's rivers and lakes
    this.water = createWater(place?.meta.water ?? [], `${BASE_PATH}/engine-assets`);
    this.space.add(this.water.object);
    this.startInDrone = !!place && place.meta.start !== "walk";

    // Camera rig

    this.cameraRig = new ThirdPersonCameraRig({
      camera: Camera.current,
      target: this._player,
      distance: 5,
      height: 0,
      collision: true,
      smoothing: 0.15,
      smoothMethod: "orbit",
    });

    // Mover
    this.mover = new Mover({
      body: this._player,
      target: Camera.current,
      movement: {
        speed: SPEED,
        gravity: GRAVITY,
        acceleration: 100,
        deceleration: 50,
        airControl: 1,
        facingMode: "movement",
      },
      jump: {
        height: 5,
        duration: 1,
        maxJumps: 2,
        coyoteTime: Infinity,
        maxFallSpeed: 20,
      },
    });

    // Animation state machine
    this.animStateMachine = createMoverAnimStateMachine({
      body: this._player,
      mover: this.mover,
      defaultBlendTime: 0.1,
      locomotionClips: {
        idle: ANIMS.idle,
        walk: ANIMS.walk,
        run: ANIMS.run,
        sprint: ANIMS.sprint,
      },
      locomotionThresholds: { walk: 10, sprint: SPEED * SPRINT_BOOST },
      jump: {
        clip: (ctx) => getJumpClip(ctx.jumpTakeoffState),
        toFallWhen: (ctx) => ctx.finished && !ctx.mover.grounded,
      },
      doubleJump: { clip: ANIMS.jump_double },
      fall: { clip: ANIMS.falling },
      landing: {
        clip: (ctx) =>
          getLandingClip(ctx.jumpTakeoffState, ctx.landingVelocityY),
      },
    });

    // Wire jump input (Space climbs instead while flying)
    this.inputs.Jump.onPerformed(() => {
      if (!this.flying) this.mover?.startJump();
    });
    this.inputs.ToggleFly.onPerformed(() => this.setFlyingState(!this.flying));

    // An embedding page (the opengeoworld web app) can toggle fly mode too: { type: "world:fly", on?: boolean }
    if (typeof window !== "undefined" && window.parent !== window) {
      window.addEventListener("message", this.onParentMessage);
    }

    // Wait for user to start
    this.setActive(false);

    // Start as a drone high above the place (overview), unless the web app asked for on foot.
    if (this.startInDrone) this.setFlyingState(true);

    // Reveal the scene now that camera and controls are set up
    await reveal();

    // Reset store state
    gameStore.update({
      started: false,
      paused: false,
    });

    // Register space event handlers
    this.cleanup = this.space.use({
      onFixedUpdate: this.onFixedUpdate,
      onUpdate: this.onUpdate,
      onDispose: this.onDispose,
    });
  }

  private onParentMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || e.data?.type !== "world:fly" || !this.controlsActive) return;
    this.setFlyingState(typeof e.data.on === "boolean" ? e.data.on : !this.flying);
  };

  dispose() {
    if (typeof window !== "undefined") window.removeEventListener("message", this.onParentMessage);

    // Clean up space event handlers
    this.cleanup?.();
    this.cleanup = null;

    this.animStateMachine?.dispose();
    this.animStateMachine = null;
    this.mover?.dispose();
    this.mover = null;
    this.cameraRig?.dispose();
    this.cameraRig = null;
    this.inputs?.dispose();
    this.inputs = null;

    // Destroy the space
    this.space?.destroy();
    this.space = null;
    scriptInstance = null;
  }

  private setActive(val: boolean) {
    this.controlsActive = val;
    if (val) {
      this.inputs?.enable();
      this.mover?.reset();
      this.animStateMachine?.forceState("idle");
    } else {
      this.inputs?.disable();
      this.animStateMachine?.forceState("idle");
    }
    if (this.cameraRig) this.cameraRig.active = val;
    if (this.animStateMachine) this.animStateMachine.enabled = val;
  }

  /**
   * Fly mode = drone mode: the avatar is swapped for a drone (same physics body, so it still
   * collides with buildings); gravity off, Space climbs, Shift descends, faster horizontal speed.
   */
  toggleFlying() {
    if (this.controlsActive) this.setFlyingState(!this.flying);
  }

  private setFlyingState(on: boolean) {
    if (this.flying === on) return;
    this.flying = on;
    setFlying(on);
    this.drone?.setActive(on);
    // Hide only the model: the camera rig stops aiming at targets whose `visible` is false.
    this._player?.setModelVisible(!on);
    if (this.cameraRig) {
      this.cameraRig.altitudeSmoothing = on ? FLYING_ALTITUDE_SMOOTHING : CAMERA_ALTITUDE_SMOOTHING;
      // Drone: camera further back for an overview; on foot: close third-person view.
      this.cameraRig.maxZoom = on ? 40 : 10;
      this.cameraRig.setZoom(on ? DRONE_CAMERA_DISTANCE : 5);
    }
    if (!this.mover) return;
    this.mover.gravity = on ? 0 : GRAVITY;
    const v = this.mover.velocity;
    v.y = 0;
    this.mover.setVelocity(v);
  }

  /**
   * When the game runs inside an iframe (the opengeoworld web app), tell the parent page where the player is,
   * where the camera looks and whether we fly, so it can draw a minimap.
   * Model frame: metres, Y up, X east, -Z north.
   */
  private postPosition(dt: number) {
    if (typeof window === "undefined" || window.parent === window || !this._player) return;
    this.postTimer += dt;
    if (this.postTimer < POSITION_POST_INTERVAL) return;
    this.postTimer = 0;
    const p = this._player.position;
    const cam = Camera.current;
    let heading = 0; // degrees clockwise from north (-Z)
    if (cam) {
      const dir = cam.getWorldDirection(new Vector3());
      heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
    }
    window.parent.postMessage(
      { type: "world:player", x: p.x, y: p.y, z: p.z, heading, flying: this.flying },
      "*",
    );
  }

  start() {
    if (!this.space) return;

    this.setActive(true);
    setStarted(true);
    this.space.start();
    // Drone start: once the camera is live (starting resets its distance), set the overview:
    // camera behind and above the drone, looking down onto the place.
    if (this.startInDrone && !this.overviewDone && this.cameraRig) {
      this.overviewDone = true;
      const s = this.cameraRig.saveState();
      s.spherical.phi = s.targetSpherical.phi = DRONE_START_PHI;
      s.spherical.radius = s.targetSpherical.radius = DRONE_CAMERA_DISTANCE;
      s.currentZoom = DRONE_CAMERA_DISTANCE;
      this.cameraRig.loadState(s);
      // The first physics steps after starting pull the body down by a variable amount (tens of
      // metres): hold the drone at its start position for a few steps.
      this.holdStart = { position: this._player!.position.clone(), steps: 20 };
    }
  }

  togglePause() {
    if (!this.space) return;

    const currentPaused = gameStore.state.paused;

    if (currentPaused) {
      // Resume
      this.setActive(true);
      this.space.start();
      setPaused(false);
    } else {
      // Pause
      this.setActive(false);
      this.space.stop();
      setPaused(true);
    }
  }

  // Called on fixed timestep for physics (via space.use)
  onFixedUpdate = (dt: number) => {
    if (!this.controlsActive || !this.inputs || !this.mover) return;

    if (this.holdStart && this._player) {
      (this._player as any).rigidBody?.teleport(this.holdStart.position, this._player.quaternion);
      if (--this.holdStart.steps <= 0) this.holdStart = null;
      return;
    }

    this.inputs.update(dt);

    const moveDir = this.inputs.Move.readValue();
    const shift = this.inputs.Sprint.isPressed;
    const speed = this.flying ? SPEED * FLY_BOOST : shift ? SPEED * SPRINT_BOOST : SPEED;

    const lookDelta = this.inputs.Look.readValue();
    const zoomDelta = this.inputs.Zoom.readValue();

    this.cameraRig?.rotate(lookDelta.x, lookDelta.y);
    this.cameraRig?.zoom(zoomDelta * 0.1);
    this.mover.move(moveDir.x, moveDir.y, speed);

    if (this.flying) {
      // Gravity is off: we set the climb rate ourselves (per step, like the mover's x/z).
      const climb = (this.inputs.Jump.isPressed ? 1 : 0) - (shift ? 1 : 0);
      const v = this.mover.velocity;
      v.y = climb * FLY_VERTICAL_SPEED * dt;
      this.mover.setVelocity(v);
    } else if (this.inputs.Jump.wasJustPressed) {
      this.mover.startJump();
    }

    this.mover.update(dt);
    // Hovering holds idle; otherwise the usual locomotion/air states.
    if (this.flying && !this.mover.isMoving) this.animStateMachine?.forceState("idle");
    else this.animStateMachine?.update(dt);
  };

  // Called every frame when game is running (via space.use)
  onUpdate = (dt: number) => {
    this.postPosition(dt);
    if (this.drone && this._player) {
      const dir = Camera.current?.getWorldDirection(new Vector3());
      this.drone.update(dt, this._player.position, dir ? Math.atan2(dir.x, dir.z) : 0);
    }
    this.water?.update(dt);
  };

  onDispose = () => {
    console.log("[Game] Game disposed");
  };
}
