-- 008_ai_settings: what the AI settings screen and the AI router (M4) need on ai_providers.
--
-- is_local: the model runs on the user's machine or network (Ollama, LM Studio, a custom
-- local URL). The router tries local models first, then a cloud model only if the user added
-- one as a fallback, then a fixed template.
-- base_url: only http(s) addresses; the app also refuses plain http for cloud models.

ALTER TABLE public.ai_providers
  ADD COLUMN is_local boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ai_providers_base_url_http CHECK (base_url ~ '^https?://');

COMMENT ON COLUMN public.ai_providers.is_local IS 'True for a model on the user''s machine or network; tried before any cloud model.';
COMMENT ON COLUMN public.ai_providers.api_key_enc IS 'Ciphertext from lib/crypto.ts (context ai_providers.api_key_enc:<user id>:<fallback_order>). Never sent to the browser.';
