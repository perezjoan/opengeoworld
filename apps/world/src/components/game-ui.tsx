"use client";

import { useEffect, useState } from "react";
import { gameStore } from "@/lib/game-store";
import { startGame } from "@/lib/game-script";
import { useStore } from "@/hooks/use-store";
import { JumpButton, isTouchScreen } from "./jump-button";

function StartScreen() {
  const state = useStore(gameStore);
  // after hydration: the page is pre-rendered without knowing the device
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchScreen()), []);

  if (state.started) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col cursor-pointer"
      onClick={() => startGame()}
    >
      <div className="bg-black/80 py-5" />
      <div className="flex-1" />
      <div className="bg-black/80 py-5 text-center text-white text-xl">
        <em className="font-bold not-italic italic">{touch ? "Tap" : "Click"}</em> to start!
      </div>
    </div>
  );
}

function PauseIndicator() {
  const state = useStore(gameStore);

  if (!state.paused) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/50 pointer-events-none">
      <div className="text-white text-4xl font-bold">PAUSED</div>
    </div>
  );
}

function FlyIndicator() {
  const state = useStore(gameStore);
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchScreen()), []);

  if (!state.started || state.paused) return null;

  // touch screens: the on-screen buttons' names, and top left (the page's minimap is top right)
  return (
    <div className={`fixed top-3 z-40 pointer-events-none select-none ${touch ? "left-3" : "left-1/2 -translate-x-1/2"}`}>
      {state.flying ? (
        <div className="rounded-full bg-sky-500/85 px-4 py-1.5 text-sm font-semibold text-white shadow whitespace-nowrap">
          {touch ? "DRONE · ▲ ▼ height · Land to walk" : "DRONE · Space up · Shift down · F to land"}
        </div>
      ) : (
        <div className="rounded-full bg-black/45 px-3 py-1 text-xs text-white/85 whitespace-nowrap">
          {touch ? "Fly for the drone" : "Press F for the drone"}
        </div>
      )}
    </div>
  );
}

export function GameUI() {
  return (
    <>
      <StartScreen />
      <PauseIndicator />
      <FlyIndicator />
      <JumpButton />
    </>
  );
}
