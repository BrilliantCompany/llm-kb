"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

export type ModelSpec = {
  id: string;
  provider: string;
  model_id: string;
  label: string;
  notes: string | null;
  api_key_configured: boolean;
  // LLM-specific
  context_window_tokens?: number;
  max_output_tokens?: number;
  supports_tools?: boolean;
  supports_vision?: boolean;
  cost_per_1m_input_tokens?: number | null;
  cost_per_1m_output_tokens?: number | null;
  // Vision-specific (included so renderMeta from settings page stays compatible)
  max_image_size_mb?: number;
  cost_per_image?: number | null;
};

type CatalogResp = {
  active_spec_id: string | null;
  specs: ModelSpec[];
};

type CustomStatus = {
  active: boolean;
  base_url: string | null;
  api_key_configured: boolean;
  model_id: string | null;
};

type FetchedModel = { id: string; owned_by: string | null };

// ── Constants ─────────────────────────────────────────────────────────────────

const CUSTOM_ID = "custom";

// ── Component ─────────────────────────────────────────────────────────────────

export function LlmCatalogCard({
  renderMeta,
}: {
  renderMeta?: (spec: ModelSpec) => React.ReactNode;
}) {
  // Catalog / status
  const [catalog, setCatalog] = useState<CatalogResp | null>(null);
  const [customStatus, setCustomStatus] = useState<CustomStatus | null>(null);

  // Selected row in the UI (spec_id or "custom")
  const [selected, setSelected] = useState<string | null>(null);

  // Catalog-model API key
  const [catalogApiKey, setCatalogApiKey] = useState("");
  const [catalogMasked, setCatalogMasked] = useState("");

  // Custom-provider form
  const [baseUrl, setBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customMasked, setCustomMasked] = useState("");
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [customModel, setCustomModel] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");

  // Save state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const [c, cs, settings] = await Promise.all([
        api<CatalogResp>("/api/settings/llm/catalog"),
        api<CustomStatus>("/api/settings/llm/custom"),
        api<Record<string, unknown>>("/api/settings"),
      ]);

      setCatalog(c);
      setCustomStatus(cs);

      // Catalog API key (masked from server)
      const raw = settings["llm_api_key"];
      const masked = typeof raw === "string" ? raw : "";
      setCatalogMasked(masked);
      setCatalogApiKey(masked);

      // Custom API key
      if (cs.api_key_configured) {
        const cm = "••••••••••••";
        setCustomMasked(cm);
        setCustomApiKey(cm);
      }

      // Pre-fill custom form fields
      if (cs.base_url) setBaseUrl(cs.base_url);
      if (cs.model_id) setCustomModel(cs.model_id);

      // Initial selection
      setSelected((prev) => {
        if (prev) return prev;
        if (cs.active) return CUSTOM_ID;
        return c.active_spec_id ?? c.specs[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load LLM settings");
    }
  }

  // ── Derived state ────────────────────────────────────────────────────────

  const isCustomSelected = selected === CUSTOM_ID;
  const isCustomActive = customStatus?.active === true;
  const selectedSpec = !isCustomSelected
    ? (catalog?.specs.find((s) => s.id === selected) ?? null)
    : null;

  // Catalog-model logic
  const isActiveSelected =
    !!selectedSpec && selectedSpec.id === catalog?.active_spec_id && !isCustomActive;
  const willSwitch = !!selectedSpec && !isActiveSelected;
  const isCatalogKeyMasked = catalogApiKey.includes("•");
  const hasNewCatalogKey = catalogApiKey.trim().length > 0 && !isCatalogKeyMasked;

  // Custom-provider logic
  const isCustomKeyMasked = customApiKey.includes("•");

  const canSave = isCustomSelected
    ? !!baseUrl.trim() && !!customModel
    : !!selectedSpec && (hasNewCatalogKey || (willSwitch && selectedSpec.api_key_configured));

  const buttonLabel = saving
    ? isCustomSelected ? "Activating…" : "Saving…"
    : isCustomSelected
    ? isCustomActive ? "Update" : "Activate"
    : willSwitch ? "Switch & Save" : "Save";

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleFetch() {
    setFetching(true);
    setFetchError("");
    setFetchedModels([]);
    try {
      const resp = await api<{ models: FetchedModel[] }>(
        "/api/settings/llm/custom/fetch-models",
        {
          method: "POST",
          body: {
            base_url: baseUrl.trim(),
            api_key: isCustomKeyMasked ? "" : customApiKey.trim(),
          },
        },
      );
      setFetchedModels(resp.models);
      if (resp.models.length > 0 && !customModel) {
        setCustomModel(resp.models[0].id);
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to fetch models");
    } finally {
      setFetching(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      if (isCustomSelected) {
        await api("/api/settings/llm/custom/activate", {
          method: "POST",
          body: {
            base_url: baseUrl.trim(),
            api_key: isCustomKeyMasked ? "" : customApiKey.trim(),
            model_id: customModel!,
          },
        });
      } else if (selectedSpec) {
        if (hasNewCatalogKey) {
          await api("/api/settings", {
            method: "PUT",
            body: { settings: { llm_api_key: catalogApiKey.trim() } },
          });
        }
        if (willSwitch) {
          await api("/api/settings/llm/switch", {
            method: "POST",
            body: { model_spec_id: selectedSpec.id },
          });
        }
      }
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!catalog) {
    return (
      <div className="bg-card rounded-xl p-6 border border-border shadow-sahara">
        <p className="text-sm text-muted-foreground">Loading LLM model…</p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl p-6 border border-border shadow-sahara">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary text-base">psychology</span>
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">LLM Model</h3>
          <p className="text-xs text-muted-foreground">
            Used for entity extraction, planning, and wiki compilation.
          </p>
        </div>
      </div>

      {/* Model list */}
      <div className="flex flex-col gap-2 mb-4">
        {/* Catalog entries */}
        {catalog.specs.map((spec) => {
          const isActive = spec.id === catalog.active_spec_id && !isCustomActive;
          const isChecked = spec.id === selected;
          return (
            <label
              key={spec.id}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                isChecked
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent/30"
              }`}
            >
              <input
                type="radio"
                name="llm-spec"
                value={spec.id}
                checked={isChecked}
                onChange={() => setSelected(spec.id)}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{spec.label}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-secondary/40 px-1.5 py-0.5 rounded">
                    {spec.provider}
                  </span>
                  {isActive && (
                    <span className="text-[10px] uppercase tracking-wide bg-green-500/15 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded">
                      Active
                    </span>
                  )}
                </div>
                {renderMeta && (
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {renderMeta(spec)}
                  </div>
                )}
                {spec.notes && (
                  <p className="text-[11px] text-muted-foreground/80 mt-1 italic">
                    {spec.notes}
                  </p>
                )}
              </div>
            </label>
          );
        })}

        {/* Custom Provider entry */}
        <div
          className={`rounded-lg border transition-colors ${
            isCustomSelected ? "border-primary bg-primary/5" : "border-border"
          }`}
        >
          {/* Clickable header row (label wraps only the radio + title) */}
          <label className="flex items-start gap-3 p-3 cursor-pointer hover:bg-accent/20 rounded-lg">
            <input
              type="radio"
              name="llm-spec"
              value={CUSTOM_ID}
              checked={isCustomSelected}
              onChange={() => setSelected(CUSTOM_ID)}
              className="mt-1"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">Custom Provider</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-secondary/40 px-1.5 py-0.5 rounded">
                  openai-compatible
                </span>
                {isCustomActive && (
                  <span className="text-[10px] uppercase tracking-wide bg-green-500/15 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {isCustomActive && customStatus?.model_id
                  ? `Using ${customStatus.model_id}`
                  : "Any endpoint that speaks the OpenAI chat/completions API."}
              </p>
            </div>
          </label>

          {/* Expanded form — outside <label> to avoid event conflicts */}
          {isCustomSelected && (
            <div className="px-4 pb-4 flex flex-col gap-3 border-t border-border/60 mt-0 pt-3">
              {/* Base URL */}
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Base URL</Label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-provider/v1"
                  className="bg-background font-mono text-sm"
                />
              </div>

              {/* API key */}
              <div className="flex flex-col gap-1">
                <Label className="text-xs">
                  API key
                  {customStatus?.api_key_configured && (
                    <span className="ml-2 text-green-600 dark:text-green-400">✓ saved</span>
                  )}
                </Label>
                <Input
                  type={isCustomKeyMasked ? "text" : "password"}
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  onFocus={() => { if (isCustomKeyMasked) setCustomApiKey(""); }}
                  onBlur={() => { if (!customApiKey) setCustomApiKey(customMasked); }}
                  placeholder={
                    customStatus?.api_key_configured
                      ? "Replace existing key…"
                      : "Paste API key (leave blank if not required)"
                  }
                  className="bg-background"
                />
              </div>

              {/* Fetch models button */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleFetch}
                  disabled={!baseUrl.trim() || fetching}
                  className="bg-secondary text-secondary-foreground px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-1.5"
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

              {/* Fetched model list */}
              {(fetchedModels.length > 0 || customModel) && (
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">
                    Model
                    {fetchedModels.length > 0 && (
                      <span className="ml-1.5 text-muted-foreground font-normal">
                        ({fetchedModels.length} available)
                      </span>
                    )}
                  </Label>

                  {fetchedModels.length === 0 && customModel ? (
                    <div className="text-xs text-muted-foreground bg-secondary/30 rounded px-2.5 py-1.5 flex items-center gap-2">
                      <span className="font-mono text-foreground">{customModel}</span>
                      <span className="opacity-70">— fetch to change</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
                      {fetchedModels.map((m) => (
                        <label
                          key={m.id}
                          className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border cursor-pointer transition-colors text-xs ${
                            customModel === m.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-accent/30"
                          }`}
                        >
                          <input
                            type="radio"
                            name="custom-llm-model"
                            value={m.id}
                            checked={customModel === m.id}
                            onChange={() => setCustomModel(m.id)}
                            className="shrink-0"
                          />
                          <span className="font-mono flex-1 truncate">{m.id}</span>
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
            </div>
          )}
        </div>
      </div>

      {/* Catalog API key (only shown when a catalog model is selected) */}
      {!isCustomSelected && selectedSpec && (
        <div className="mb-4 flex flex-col gap-1.5">
          <Label className="text-xs">
            API key
            {selectedSpec.api_key_configured && (
              <span className="ml-2 text-green-600 dark:text-green-400">✓ saved</span>
            )}
          </Label>
          <Input
            type={isCatalogKeyMasked ? "text" : "password"}
            value={catalogApiKey}
            onChange={(e) => setCatalogApiKey(e.target.value)}
            onFocus={() => { if (isCatalogKeyMasked) setCatalogApiKey(""); }}
            onBlur={() => { if (!catalogApiKey) setCatalogApiKey(catalogMasked); }}
            placeholder={
              selectedSpec.api_key_configured ? "Replace existing key…" : "Paste API key"
            }
            className="bg-background"
          />
        </div>
      )}

      {/* Action row */}
      <div className="flex items-center gap-3">
        <button
          disabled={!canSave || saving}
          onClick={handleSave}
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {buttonLabel}
        </button>
        {saved && (
          <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            Saved
          </span>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
