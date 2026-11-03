import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Service {
  image?: string;
  profiles?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  healthcheck?: { test?: string[] };
}

const root = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");

const composeText = read("docker-compose.yml");
const compose = parse(composeText) as { services?: Record<string, Service> };
const services = compose.services ?? {};
const service = (name: string): Service => {
  const found = services[name];
  if (!found) throw new Error(`docker-compose.yml has no "${name}" service`);
  return found;
};

const SERVICES = ["postgres", "n8n", "litellm", "ollama"] as const;
const SECRET_NAME = /PASSWORD|SECRET|KEY|TOKEN/;

describe("docker-compose.yml", () => {
  it.each(SERVICES)("defines %s with a health check", (name) => {
    expect(service(name).healthcheck?.test?.length).toBeGreaterThan(0);
  });

  it.each(SERVICES)("pins the %s image to a version", (name) => {
    const image = service(name).image ?? "";
    expect(image).toMatch(/:[\w.-]+$/);
    expect(image).not.toMatch(/:latest$/);
  });

  it("starts Ollama only with the ollama profile", () => {
    expect(service("ollama").profiles).toEqual(["ollama"]);
    for (const name of ["postgres", "n8n", "litellm"]) {
      expect(service(name).profiles, `${name} must start by default`).toBeUndefined();
    }
  });

  it.each(SERVICES)("publishes %s ports on localhost only", (name) => {
    for (const port of service(name).ports ?? []) {
      expect(port).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it.each(SERVICES)("takes %s secrets from the environment, never literals", (name) => {
    const env = service(name).environment ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (SECRET_NAME.test(key)) expect(value, key).toMatch(/^\$\{\w+:\?.+\}$/);
    }
  });

  it("mounts the LiteLLM config and the n8n workflows folder", () => {
    expect(service("litellm").volumes?.join(" ")).toContain("./gateway/litellm.config.yaml");
    expect(service("n8n").volumes?.join(" ")).toContain("./n8n/workflows");
  });

  it("documents every variable it uses in .env.example", () => {
    const used = [...composeText.matchAll(/\$\{(\w+)/g)].map((match) => match[1]);
    const documented = new Set(
      [...read(".env.example").matchAll(/^(\w+)=/gm)].map((match) => match[1]),
    );
    for (const name of new Set(used)) {
      expect(documented.has(name), `${String(name)} missing from .env.example`).toBe(true);
    }
  });
});

describe("gateway/litellm.config.yaml", () => {
  const config = parse(read("gateway/litellm.config.yaml")) as {
    general_settings?: { master_key?: string };
    model_list?: { model_name?: string }[];
  };

  it("reads the master key from the environment", () => {
    expect(config.general_settings?.master_key).toBe("os.environ/LITELLM_MASTER_KEY");
  });

  it("has an offline mock model for smoke tests", () => {
    expect(config.model_list?.map((model) => model.model_name)).toContain("mock");
  });
});
