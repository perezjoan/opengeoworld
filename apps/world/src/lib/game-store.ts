import { Store } from "@/hooks/use-store";

interface GameState {
  started: boolean;
  paused: boolean;
  flying: boolean;
}

export const gameStore = new Store<GameState>({
  started: false,
  paused: false,
  flying: false,
});

export function setFlying(flying: boolean) {
  gameStore.update({ flying });
}

export function setStarted(started: boolean) {
  gameStore.update({ started });
}

export function setPaused(paused: boolean) {
  gameStore.update({ paused });
}
