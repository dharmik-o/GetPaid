"use client";

import { ThemeProvider as NextThemes } from "next-themes";
import type { ReactNode } from "react";

/**
 * Sets data-theme on <html> before the first paint. The first visit follows the device; after a
 * tap on the toggle, the saved choice wins.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => (
  <NextThemes attribute="data-theme" defaultTheme="system" enableSystem>
    {children}
  </NextThemes>
);
