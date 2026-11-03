import { AiSettingsForm } from "@/components/AiSettingsForm";
import { getAiSettings } from "@/lib/ai-settings";
import { runAsCurrentUser } from "@/lib/request-user";

// Bring your own AI: provider, base URL, key (write-only), model, per-task models.

export const dynamic = "force-dynamic";

const AiSettingsPage = async () => {
  const settings = await runAsCurrentUser((db) => getAiSettings(db));
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
      <section className="card" aria-labelledby="ai-model">
        <h2 id="ai-model">Model</h2>
        <AiSettingsForm initial={settings} />
      </section>
    </div>
  );
};

export default AiSettingsPage;
