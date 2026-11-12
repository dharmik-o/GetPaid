import { AiSettingsForm } from "@/components/AiSettingsForm";
import { AiTestPanel } from "@/components/AiTestPanel";
import { LocalAiPanel } from "@/components/LocalAiPanel";
import { UseBuiltInAi } from "@/components/UseBuiltInAi";
import { defaultAiInfo, type DefaultAiInfo } from "@/lib/ai-default";
import { getAiSettings } from "@/lib/ai-settings";
import { isDemoMode } from "@/lib/demo-gate";
import { localAiStatus, localAiUrl, SUGGESTED_MODELS } from "@/lib/local-ai";
import { runAsCurrentUser } from "@/lib/request-user";

// Bring your own AI: provider, base URL, key (write-only), model, per-task models. On the public
// demo it's read-only: every visitor shares one account and uses the server's built-in model.

export const dynamic = "force-dynamic";

const DemoAiSettings = ({ builtIn }: { builtIn: DefaultAiInfo | null }) => (
  <div className="page">
    <div className="page-header">
      <h1>AI settings</h1>
    </div>
    <section className="card" aria-labelledby="ai-model" data-tour="ai-model">
      <h2 id="ai-model">Model</h2>
      {builtIn ? (
        <p>
          This demo uses the built-in <strong>{builtIn.label}</strong> model (
          <code>{builtIn.model}</code>) for drafts, reply sorting and the help assistant. No key is
          needed, and none is ever shown.
        </p>
      ) : (
        <p>This demo has no AI model set up, so drafts use the fixed templates.</p>
      )}
      <p className="muted">
        Settings here are locked on the demo, because every visitor shares one account. In your own
        copy of GetPaid you can pick any provider (Claude, OpenAI, Gemini, Groq, OpenRouter, Ollama
        or LM Studio), add your own key and choose a model per task.
      </p>
    </section>
    {builtIn ? (
      <section className="card" aria-labelledby="ai-test">
        <h2 id="ai-test">Test connection</h2>
        <AiTestPanel hasSettings />
      </section>
    ) : null}
  </div>
);

const AiSettingsPage = async () => {
  const settings = await runAsCurrentUser((db) => getAiSettings(db));
  const localUrl = localAiUrl();
  const local = await localAiStatus(localUrl);
  const builtIn = defaultAiInfo();
  if (isDemoMode()) return <DemoAiSettings builtIn={builtIn} />;
  return (
    <div className="page">
      <div className="page-header">
        <h1>AI settings</h1>
      </div>
      {builtIn ? (
        <section className="card" aria-labelledby="ai-builtin">
          <h2 id="ai-builtin">{settings.main ? "Your own model" : "Built-in AI"}</h2>
          {settings.main ? (
            <>
              <p>
                You&apos;re using your own model ({settings.main.model}). The built-in{" "}
                {builtIn.label} model is still there if you want it back.
              </p>
              <UseBuiltInAi label={builtIn.label} model={builtIn.model} />
            </>
          ) : (
            <p>
              You&apos;re using the built-in <strong>{builtIn.label}</strong> model (
              <code>{builtIn.model}</code>), provided by this server, so you don&apos;t need a key.
              To use your own provider and key instead, choose them below and save.
            </p>
          )}
        </section>
      ) : settings.main ? null : (
        <p className="empty">
          No model yet. Pick a provider below: a local model (Ollama, LM Studio) keeps client emails
          on your machine; a cloud model needs its API key. Until one is saved, drafts use a fixed
          template.
        </p>
      )}
      <section className="card" aria-labelledby="ai-model" data-tour="ai-model">
        <h2 id="ai-model">Model</h2>
        <AiSettingsForm
          initial={settings}
          start={builtIn ? { provider: builtIn.provider, model: builtIn.model } : undefined}
          localAiUrl={localUrl}
          localModels={local.up ? local.models : []}
        />
      </section>
      <section className="card" aria-labelledby="ai-local">
        <h2 id="ai-local">Local AI (Ollama)</h2>
        <LocalAiPanel status={local} suggested={SUGGESTED_MODELS} demo={isDemoMode()} />
      </section>
      <section className="card" aria-labelledby="ai-test">
        <h2 id="ai-test">Test connection</h2>
        <AiTestPanel hasSettings={settings.main !== null || builtIn !== null} />
      </section>
    </div>
  );
};

export default AiSettingsPage;
