"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => undefined;

/** The theme is only known in the browser, so the server and first render stay neutral. */
const useInBrowser = (): boolean =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

const labelFor = (inBrowser: boolean, theme: string | undefined): string => {
  if (!inBrowser) return "Switch colour theme";
  return theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
};

/** Round button in the header. CSS picks the icon from data-theme, so it never shows the wrong one. */
export const ThemeToggle = () => {
  const { resolvedTheme, setTheme } = useTheme();
  const inBrowser = useInBrowser();
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={labelFor(inBrowser, resolvedTheme)}
      onClick={() => {
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
      }}
    >
      <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3 7 7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7" />
      </svg>
      <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      </svg>
    </button>
  );
};
