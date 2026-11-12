// The pages the help assistant may point to. Its answer lists routes, and only these exact ones are
// ever shown as links: anything else the model writes is dropped. No server code, so the panel and
// the server share one list. prompts/help-assistant.md names the same routes.

export const HELP_ROUTES: Readonly<Record<string, string>> = {
  "/": "Home",
  "/outbox": "Outbox",
  "/clients": "Clients",
  "/clients/new": "Add a client",
  "/projects": "Projects",
  "/projects/new": "New project",
  "/retainers": "Retainers",
  "/retainers/new": "Add a retainer",
  "/maintenance": "Maintenance",
  "/maintenance/new": "Add a maintenance job",
  "/calendar": "Calendar",
  "/settings": "Settings",
  "/settings/ai": "Settings > AI",
  "/settings/integrations": "Settings > Integrations",
  "/settings/templates": "Settings > Invoice templates",
};

export type HelpLink = { href: string; label: string };

const MAX_LINKS = 5;

/** Only exact routes from the list, each once, in the order given. */
export const allowedLinks = (hrefs: readonly string[]): HelpLink[] => {
  const seen = new Set<string>();
  const links: HelpLink[] = [];
  for (const href of hrefs) {
    const label = Object.hasOwn(HELP_ROUTES, href) ? HELP_ROUTES[href] : undefined;
    if (label === undefined || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, label });
  }
  return links.slice(0, MAX_LINKS);
};

export const MANUAL_PDF = "/GetPaid-User-Manual.pdf";
