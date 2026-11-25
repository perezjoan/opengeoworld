"use client";

import { sharedControlState } from "@opengeoworld/engine/input";
import { useEffect, useState } from "react";
import { useStore } from "@/hooks/use-store";
import { gameStore } from "@/lib/game-store";
import { toggleFlying } from "@/lib/game-script";

export function isTouchScreen(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(pointer: coarse)").matches ||
    "ontouchstart" in window
  );
}

const BUTTON =
  "pointer-events-auto flex items-center justify-center rounded-full border border-white/25 bg-black/30 font-semibold uppercase text-white shadow-[0_18px_50px_rgba(0,0,0,0.3)] backdrop-blur-md select-none";

/** A touch button that holds a custom input button ("jump", "down", "fly") while pressed. */
function HoldButton({ name, className, children }: { name: string; className: string; children: React.ReactNode }) {
  // released a little later: a quick tap is still seen by the next game frame
  const release = () => setTimeout(() => sharedControlState.custom.releaseButton(name), 80);
  return (
    <button
      type="button"
      className={`${BUTTON} ${className}`}
      style={{ touchAction: "none" }}
      onPointerDown={(event) => {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not a live pointer */ }
        sharedControlState.custom.pressButton(name);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        release();
      }}
      onPointerCancel={release}
      onPointerLeave={release}
    >
      {children}
    </button>
  );
}

/**
 * Touch controls on the right (the move joystick is on the left): Jump on foot; Up and Down while
 * flying the drone; and Land / Fly to switch (F on a keyboard).
 */
export function JumpButton() {
  const [enabled, setEnabled] = useState(false);
  const { flying } = useStore(gameStore);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia("(pointer: coarse)");
    const update = () => {
      setEnabled(isTouchScreen());
    };

    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);

    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      for (const b of ["jump", "down"]) sharedControlState.custom.releaseButton(b);
    };
  }, []);

  if (!enabled) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      <div className="fixed bottom-4 right-4 flex flex-col items-center gap-3">
        {/* a switch, not a held input: a quick tap must count */}
        <button
          type="button"
          className={`${BUTTON} h-11 w-16 text-[10px] tracking-[0.14em]`}
          style={{ touchAction: "none" }}
          onPointerDown={(event) => { event.preventDefault(); toggleFlying(); }}
        >
          {flying ? "Land" : "Fly"}
        </button>
        {flying && (
          <HoldButton name="down" className="h-14 w-14 text-[11px] tracking-[0.18em]">
            ▼
          </HoldButton>
        )}
        <HoldButton name="jump" className="h-16 w-16 text-[11px] tracking-[0.22em]">
          {flying ? "▲" : "Jump"}
        </HoldButton>
      </div>
    </div>
  );
}
