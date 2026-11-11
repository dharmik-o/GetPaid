import { AiSettingsForm } from "@/components/AiSettingsForm";
import { AiTestPanel } from "@/components/AiTestPanel";
import { LocalAiPanel } from "@/components/LocalAiPanel";
import { getAiSettings } from "@/lib/ai-settings";
import { isDemoMode } from "@/lib/demo-gate";
import { localAiStatus, localAiUrl, SUGGESTED_MODELS } from "@/lib/local-ai";
import { runAsCurrentUser } from "@/lib/request-user";

// Bring your own AI: provider, base URL, key (write-only), model, per-task models.

export const dynamic = "force-dynamic";

const AiSettingsPage = async () => {
  const settings = await runAsCurrentUser((db) => getAiSettings(db));
  const localUrl = localAiUrl();
  const local = await localAiStatus(localUrl);
  return (
    <div className="page">
      <div className="page-header">
        <h1>AI settings</h1>
      </div>
      {settings.main ? null : (
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
        <AiTestPanel hasSettings={settings.main !== null} />
      </section>
    </div>
  );
};

export default AiSettingsPage;
