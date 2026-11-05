"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef, type ReactNode } from "react";

// All of the landing page's motion, in one place. The server sends the finished page, and every
// animation plays up to that state, so with reduced motion or no JavaScript it's simply all there.
// The CSS holds the hero hidden for a moment so it doesn't flash before its timeline starts.

const MOVES = "(prefers-reduced-motion: no-preference)";
const WIDE = "(min-width: 761px)";
const NARROW = "(max-width: 760px)";
const ENTER = "power3.out";
const SCROLLED_PX = 40;
const STAMP_SECONDS = 0.45;

// Scroll reveals use opacity, not visibility, so a link in one can still be reached with Tab.
const playHero = (root: HTMLElement): void => {
  const pick = (name: string) => root.querySelectorAll(`[data-hero="${name}"]`);
  const card = root.querySelector('[data-hero="card"]');
  gsap.set(root.querySelector(".landing-hero"), { "--hero-hold": "visible" });
  const timeline = gsap.timeline({ defaults: { ease: ENTER } });
  timeline
    .from(pick("line"), { yPercent: 115, duration: 0.95, stagger: 0.1 })
    .from(pick("fade"), { y: 18, autoAlpha: 0, duration: 0.7, stagger: 0.1 }, "-=0.5")
    .fromTo(
      card,
      { y: 80, rotation: 6, autoAlpha: 0 },
      { y: 0, rotation: -2.5, autoAlpha: 1, duration: 0.9 },
      "-=0.6",
    )
    .from(pick("row"), { y: 14, autoAlpha: 0, duration: 0.4, stagger: 0.08 }, "-=0.3")
    .fromTo(
      root.querySelector(".invoice-pill-sent"),
      { autoAlpha: 1 },
      { autoAlpha: 0, duration: 0.25 },
      "+=0.25",
    )
    .fromTo(
      root.querySelector(".invoice-pill-paid"),
      { autoAlpha: 0, scale: 0.6 },
      { autoAlpha: 1, scale: 1, duration: 0.45, ease: "back.out(3)" },
      "<",
    )
    .fromTo(
      root.querySelector(".landing-stamp"),
      { scale: 2.8, rotation: -50, autoAlpha: 0 },
      { scale: 1, rotation: -14, autoAlpha: 1, duration: STAMP_SECONDS, ease: "power4.in" },
      "+=0.15",
    )
    .to(card, { y: 7, duration: 0.08, ease: "power2.out" })
    .to(card, { y: 0, duration: 0.25, ease: "power2.out" });
};

const driftTriangles = (root: HTMLElement): void => {
  root.querySelectorAll<HTMLElement>("[data-parallax]").forEach((triangle, index) => {
    const direction = index % 2 === 0 ? 1 : -1;
    gsap.to(triangle, {
      yPercent: 28 * direction,
      rotation: 16 * direction,
      ease: "none",
      scrollTrigger: {
        trigger: triangle.closest("[data-section]"),
        start: "top bottom",
        end: "bottom top",
        scrub: true,
      },
    });
  });
};

const revealHeadings = (root: HTMLElement): void => {
  root.querySelectorAll("[data-reveal]").forEach((heading) => {
    gsap.from(heading, {
      y: 36,
      opacity: 0,
      duration: 0.8,
      ease: ENTER,
      scrollTrigger: { trigger: heading, start: "top 85%", once: true },
    });
  });
};

const fillTrack = (root: HTMLElement): void => {
  const wrap = root.querySelector("[data-how]");
  const fills = root.querySelectorAll(".how-circle-fill");
  const timeline = gsap.timeline({
    scrollTrigger: { trigger: wrap, start: "top 75%", end: "bottom 45%", scrub: 0.6 },
  });
  timeline.from(root.querySelector(".how-track-fill"), {
    scaleX: 0,
    transformOrigin: "left center",
    ease: "none",
    duration: 3,
  });
  fills.forEach((fill, index) => {
    timeline.from(fill, { opacity: 0, duration: 0.15, ease: "none" }, index);
  });
};

const staggerSteps = (root: HTMLElement): void => {
  gsap.from(root.querySelectorAll(".how-step"), {
    y: 36,
    opacity: 0,
    duration: 0.7,
    stagger: 0.1,
    ease: ENTER,
    scrollTrigger: { trigger: root.querySelector("[data-how]"), start: "top 85%", once: true },
  });
};

const raisePanels = (root: HTMLElement): void => {
  const timeline = gsap.timeline({
    scrollTrigger: { trigger: root.querySelector("[data-panels]"), start: "top 85%", once: true },
  });
  timeline
    .from(root.querySelectorAll("[data-panel]"), {
      y: 60,
      opacity: 0,
      duration: 0.8,
      stagger: 0.12,
      ease: ENTER,
    })
    .from(
      root.querySelectorAll("[data-item]"),
      { y: 12, opacity: 0, duration: 0.4, stagger: 0.05, ease: ENTER },
      "-=0.4",
    );
};

const fillBand = (root: HTMLElement): void => {
  gsap.fromTo(
    root.querySelectorAll(".band-word"),
    { opacity: 0.16 },
    {
      opacity: 1,
      stagger: 0.1,
      ease: "none",
      scrollTrigger: {
        trigger: root.querySelector("[data-band]"),
        start: "top 80%",
        end: "bottom 60%",
        scrub: true,
      },
    },
  );
};

/** The nav's background isn't motion, so this runs whatever the reduced-motion setting says. */
const settleNav = (root: HTMLElement): ScrollTrigger =>
  ScrollTrigger.create({
    start: SCROLLED_PX,
    end: "max",
    toggleClass: { targets: root.querySelector(".landing-nav"), className: "is-scrolled" },
  });

export const LandingMotion = ({ children }: { children: ReactNode }) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    gsap.registerPlugin(ScrollTrigger);
    const nav = settleNav(root);
    const media = gsap.matchMedia();
    media.add(MOVES, () => {
      playHero(root);
      driftTriangles(root);
      revealHeadings(root);
      raisePanels(root);
      fillBand(root);
    });
    media.add(`${MOVES} and ${WIDE}`, () => {
      fillTrack(root);
    });
    media.add(`${MOVES} and ${NARROW}`, () => {
      staggerSteps(root);
    });
    // Clash Display changes the page's height as it loads, and scroll positions depend on that.
    const measure = (): void => {
      ScrollTrigger.refresh();
    };
    document.fonts.ready.then(measure, measure);
    return () => {
      nav.kill();
      media.revert();
    };
  }, []);

  return (
    <div className="landing" ref={rootRef}>
      {children}
    </div>
  );
};
