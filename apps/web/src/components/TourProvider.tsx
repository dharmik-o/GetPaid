"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TourCard } from "@/components/TourCard";
import type { TourState } from "@/lib/tour";
import { TIPS, mainSteps, tipForPath, type TipKey, type TourStep } from "@/lib/tour-steps";

// The guided tour: the main walkthrough on a first visit, and a short tip the first time a page is
// opened. Progress is saved on the server (/api/tour). If it can't be loaded, there is no tour.

type Active = { kind: "main" } | { kind: "tip"; key: TipKey };
type SavedEvent =
  { event: "complete" | "skip" | "replay" | "reset-tips" } | { event: "tip-seen"; tip: TipKey };

type TourControls = {
  /** False until the saved progress has loaded: the buttons wait. */
  ready: boolean;
  restart: () => Promise<void>;
  resetTips: () => Promise<void>;
};
const TourContext = createContext<TourControls | null>(null);

/** Settings' "Replay tour" and "Reset page tips". */
export const useTour = (): TourControls | null => useContext(TourContext);

const save = async (body: SavedEvent): Promise<TourState | null> => {
  try {
    const response = await fetch("/api/tour", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok ? ((await response.json()) as TourState) : null;
  } catch {
    // Offline: the tour is a nicety, so a failed save only means it may show again.
    return null;
  }
};

export const TourProvider = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();
  const [progress, setProgress] = useState<TourState | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [index, setIndex] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const quietPath = useRef<string | null>(null);
  const pushed = useRef<string | null>(null);

  const begin = useCallback((next: Active) => {
    const now = document.activeElement;
    opener.current = now instanceof HTMLElement && now !== document.body ? now : null;
    setIndex(0);
    setActive(next);
  }, []);

  const close = useCallback(() => {
    setActive(null);
    quietPath.current = window.location.pathname;
    if (opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/tour");
        if (!response.ok || cancelled) return;
        const state = (await response.json()) as TourState;
        setProgress(state);
        if (!state.mainDone) begin({ kind: "main" });
      } catch {
        // No tour without its saved progress.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [begin]);

  const steps: TourStep[] = useMemo(() => {
    if (!active) return [];
    return active.kind === "main" ? mainSteps(progress?.projectId ?? null) : TIPS[active.key];
  }, [active, progress?.projectId]);
  const step = steps[index];
  const mainPath =
    active?.kind === "main" ? mainSteps(progress?.projectId ?? null)[index]?.path : undefined;

  // The first visit to a page, once the main tour is out of the way.
  useEffect(() => {
    if (quietPath.current !== null && quietPath.current !== pathname) quietPath.current = null;
    if (!progress?.mainDone || active || quietPath.current === pathname) return;
    const tip = tipForPath(pathname);
    if (!tip || progress.tipsSeen.includes(tip)) return;
    setProgress({ ...progress, tipsSeen: [...progress.tipsSeen, tip] });
    void save({ event: "tip-seen", tip });
    begin({ kind: "tip", key: tip });
  }, [pathname, progress, active, begin]);

  // A tip belongs to its page: leave the page and it goes.
  useEffect(() => {
    if (active?.kind === "tip" && tipForPath(pathname) !== active.key) setActive(null);
  }, [pathname, active]);

  // The main tour moves between pages with the router, never a reload.
  useEffect(() => {
    if (!mainPath || mainPath === pathname) return;
    const mark = `${String(index)}:${mainPath}`;
    if (pushed.current === mark) return;
    pushed.current = mark;
    router.push(mainPath);
  }, [mainPath, pathname, index, router]);

  const finish = useCallback(() => {
    if (active?.kind === "main") {
      setProgress((now) => (now ? { ...now, mainDone: true } : now));
      void save({ event: "complete" });
    }
    close();
  }, [active, close]);

  const skip = useCallback(() => {
    if (active?.kind === "main") {
      setProgress((now) => (now ? { ...now, mainDone: true } : now));
      void save({ event: "skip" });
    }
    close();
  }, [active, close]);

  const next = useCallback(() => {
    if (index + 1 >= steps.length) finish();
    else setIndex(index + 1);
  }, [index, steps.length, finish]);

  const back = useCallback(() => {
    setIndex((now) => Math.max(0, now - 1));
  }, []);

  const ready = progress !== null;
  const controls = useMemo<TourControls>(
    () => ({
      ready,
      restart: async () => {
        pushed.current = null;
        const state = await save({ event: "replay" });
        if (!state) return;
        setProgress(state);
        begin({ kind: "main" });
      },
      resetTips: async () => {
        const state = await save({ event: "reset-tips" });
        if (state) setProgress(state);
      },
    }),
    [ready, begin],
  );

  const showing =
    step &&
    active &&
    (active.kind === "main" ? mainPath === pathname : tipForPath(pathname) === active.key);

  return (
    <TourContext.Provider value={controls}>
      {children}
      {showing ? (
        <TourCard
          key={`${active.kind}-${String(index)}`}
          step={step}
          index={index}
          total={steps.length}
          kind={active.kind === "main" ? "tour" : "tips"}
          onBack={back}
          onNext={next}
          onSkip={skip}
        />
      ) : null}
    </TourContext.Provider>
  );
};
