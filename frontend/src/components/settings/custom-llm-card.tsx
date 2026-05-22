"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

type FetchedModel = { id: string; owned_by: string | null };

type CustomProviderStatus = {
  active: boolean;
  base_url: string | null;
  api_key_configured: boolean;
  model_id: string | null;
};

export function CustomLlmCard() {
  const [status, setStatus] = useState<CustomProviderStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maskedKey, setMaskedKey] = useState("");
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [activating, setActivating] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadStatus() {
    try {
      const s = await api<CustomProviderStatus>("/api/settings/llm/custom");
      setStatus(s);
      if (s.base_url) setBaseUrl(s.base_url);
      if (s.api_key_configured) {
        const masked = "••••••••••••";
        setMaskedKey(masked);
        setApiKey(masked);
      }
      if (s.model_id) setSelectedModel(s.model_id);
    } catch {
      // non-fatal — card degrades gracefully
    }
  }

  const isMaskedKey = apiKey.includes("•");

  async function handleFetch() {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError("");
    setModels([]);
    try {
      const resp = await api<{ models: FetchedModel[] }>(
        "/api/settings/llm/custom/fetch-models",
        {
          method: "POST",
          body: {
            base_url: baseUrl.trim(),
            api_key: isMaskedKey ? "" : apiKey.trim(),
          },
        },
      );
      setModels(resp.models);
      if (resp.models.length > 0 && !selectedModel) {
        setSelectedModel(resp.models[0].id);
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to fetch models");
    } finally {
      setFetching(false);
    }
  }

  async function handleActivate() {
    if (!selectedModel || !baseUrl.trim()) return;
    setActivating(true);
    setSaveError("");
    setSaved(false);
    try {
      await api("/api/settings/llm/custom/activate", {
        method: "POST",
        body: {
          base_url: baseUrl.trim(),
          api_key: isMaskedKey ? "" : apiKey.trim(),
          model_id: selectedModel,
        },
      });
      await loadStatus();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Activation failed");
    } finally {
      setActivating(false);
    }
  }

  const canActivate = !!selectedModel && !!baseUrl.trim();

  return (
    <div className="bg-card rounded-xl p-6 border border-border shadow-sahara">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary text-base">hub</span>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground">Custom Provider</h3>
            {status?.active && (
              <span className="text-[10px] uppercase tracking-wide bg-green-500/15 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded">
                Active
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Use any OpenAI-compatible endpoint as the LLM provider.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* Base URL */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-provider/v1"
            className="bg-background font-mono text-sm"
          />
        </div>

        {/* API key */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">
            API key
            {status?.api_key_configured && (
              <span className="ml-2 text-green-600 dark:text-green-400">✓ saved</span>
            )}
          </Label>
          <Input
            type={isMaskedKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onFocus={() => {
              if (isMaskedKey) setApiKey("");
            }}
            onBlur={() => {
              if (!apiKey) setApiKey(maskedKey);
            }}
            placeholder={
              status?.api_key_configured ? "Replace existing key…" : "Paste API key (leave blank if not required)"
            }
            className="bg-background"
          />
        </div>

        {/* Fetch models */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleFetch}
            disabled={!baseUrl.trim() || fetching}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-2"
          >
            {fetching ? (
              <>
                <span className="material-symbols-outlined text-sm animate-spin">
                  progress_activity
                </span>
                Fetching…
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">sync</span>
                Fetch Models
              </>
            )}
          </button>
          {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}
        </div>

        {/* Model selection */}
        {(models.length > 0 || selectedModel) && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">
              Model
              {models.length > 0 && (
                <span className="ml-1.5 text-muted-foreground">
                  ({models.length} available)
                </span>
              )}
            </Label>

            {models.length === 0 && selectedModel ? (
              // Previously configured — show current selection, prompt to re-fetch
              <div className="flex items-center gap-2 text-xs px-3 py-2 bg-secondary/30 rounded-lg">
                <span className="material-symbols-outlined text-sm text-muted-foreground">
                  smart_toy
                </span>
                <span className="font-mono text-foreground">{selectedModel}</span>
                <span className="text-muted-foreground ml-1">— fetch to see all models</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1">
                {models.map((m) => (
                  <label
                    key={m.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                      selectedModel === m.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/30"
                    }`}
                  >
                    <input
                      type="radio"
                      name="custom-llm-model"
                      value={m.id}
                      checked={selectedModel === m.id}
                      onChange={() => setSelectedModel(m.id)}
                      className="shrink-0"
                    />
                    <span className="font-mono text-xs flex-1 truncate">{m.id}</span>
                    {m.owned_by && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {m.owned_by}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Activate */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleActivate}
            disabled={!canActivate || activating}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {activating ? "Activating…" : "Activate"}
          </button>
          {saved && (
            <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">check_circle</span>
              Activated
            </span>
          )}
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </div>

        {/* Current active info */}
        {status?.active && status.model_id && (
          <div className="text-xs text-muted-foreground bg-secondary/30 rounded-lg px-3 py-2 flex items-center gap-2">
            <span className="material-symbols-outlined text-sm text-green-600 dark:text-green-400">
              check_circle
            </span>
            <span>
              Active:{" "}
              <span className="font-mono text-foreground">{status.model_id}</span>
              {status.base_url && (
                <span className="ml-2 opacity-70 break-all">{status.base_url}</span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
