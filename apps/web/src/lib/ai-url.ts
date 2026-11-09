// Checks for a model's base URL, used when it's saved and again before every call. The server
// calls these addresses, so they're limited: http(s) only, no credentials in the URL, never a
// cloud metadata address, and https for anything that isn't on the user's own machine or
// network (an API key must never travel unencrypted). Pure: safe in client components.

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "[fd00:ec2::254]"]);

/** Link-local addresses (169.254.0.0/16) host cloud metadata services; never call them. */
const isBlockedHost = (hostname: string): boolean =>
  METADATA_HOSTS.has(hostname) ||
  hostname.startsWith("169.254.") ||
  hostname.startsWith("[::ffff:a9fe:") ||
  hostname.startsWith("[fe80:");

// The public demo (decision E9): a visitor can type any "Custom URL", and the server would call
// it. So the demo only reaches the known providers and the two local services, by exact host and
// the usual port, never another service on the Docker network (postgres, n8n, caddy...).
const DEMO_CLOUD_HOSTS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "openrouter.ai",
]);
const DEMO_LOCAL_SERVICES = new Map([
  ["ollama", "11434"],
  ["litellm", "4000"],
]);

const demoHostProblem = (url: URL): string | undefined => {
  const localPort = DEMO_LOCAL_SERVICES.get(url.hostname);
  if (localPort !== undefined) {
    return url.protocol === "http:" && url.port === localPort
      ? undefined
      : `must be http://${url.hostname}:${localPort} on the public demo`;
  }
  return DEMO_CLOUD_HOSTS.has(url.hostname) && url.protocol === "https:" && url.port === ""
    ? undefined
    : "isn't allowed on the public demo. Use a known provider (Claude, OpenAI, Gemini, Groq or OpenRouter)";
};

/** What's wrong with this base URL, or undefined when it's fine. */
export const baseUrlProblem = (raw: string, isLocal: boolean, demo = false): string | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a full address, like https://api.example.com/v1";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "must start with https:// (or http:// for a model on your own machine)";
  }
  if (url.username || url.password) {
    return "can't contain a user name or password. Put the key in API key instead.";
  }
  if (url.search || url.hash) return "can't have a ? or # part";
  if (isBlockedHost(url.hostname))
    return "points at a cloud metadata address, which is never allowed";
  if (!isLocal && url.protocol !== "https:") {
    return "must start with https:// for a cloud model, so the API key is never sent unencrypted";
  }
  return demo ? demoHostProblem(url) : undefined;
};

/** Same scheme, host and port: a stored key is only ever reused for the same server. */
export const sameServer = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};
