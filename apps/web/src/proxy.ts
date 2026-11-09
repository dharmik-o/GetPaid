import { NextResponse, type NextRequest } from "next/server";
import { DEMO_COOKIE, gateDecision } from "@/lib/demo-gate";

// The public demo's password gate (decision E7). It does nothing unless production and
// DEMO_MODE=true; the decision itself is gateDecision in lib/demo-gate.ts.

export const proxy = (request: NextRequest): NextResponse => {
  const { pathname, search } = request.nextUrl;
  const decision = gateDecision({
    pathname,
    search,
    cookie: request.cookies.get(DEMO_COOKIE)?.value,
    env: process.env,
    nowMs: Date.now(),
  });
  if (decision.action === "allow") return NextResponse.next();
  if (decision.action === "unauthorized") {
    return NextResponse.json(
      { error: "Sign in first: open /demo-login and enter the demo password." },
      { status: 401 },
    );
  }
  const login = new URL("/demo-login", request.url);
  login.searchParams.set("next", decision.next);
  return NextResponse.redirect(login);
};
