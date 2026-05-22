"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/shared/page-header";
import { EmbeddingSettingsCard } from "@/components/settings/embedding-settings-card";
import { NotificationChannelsCard } from "@/components/settings/notification-channels-card";
import { LlmCatalogCard } from "@/components/settings/llm-catalog-card";
import {
  ModelCatalogCard,
  type ModelSpec,
} from "@/components/settings/model-catalog-card";

function fmtTokens(n: number | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtUSD(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toFixed(n < 1 ? 2 : 2)}`;
}

function llmMeta(s: ModelSpec) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      <span>Context: {fmtTokens(s.context_window_tokens)} tokens</span>
      <span>Out: {fmtTokens(s.max_output_tokens)}</span>
      {s.supports_tools && <span className="text-green-600 dark:text-green-400">tools</span>}
      {s.supports_vision && <span className="text-blue-600 dark:text-blue-400">vision</span>}
      <span>
        {fmtUSD(s.cost_per_1m_input_tokens)} in / {fmtUSD(s.cost_per_1m_output_tokens)} out per 1M
      </span>
    </div>
  );
}

function visionMeta(s: ModelSpec) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      <span>Max image: {s.max_image_size_mb} MB</span>
      <span>{fmtUSD(s.cost_per_1m_input_tokens)} per 1M input tokens</span>
      {s.cost_per_image != null && <span>{fmtUSD(s.cost_per_image)} / image</span>}
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.replace("/");
    }
  }, [user, router]);

  if (!user || user.role !== "admin") {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="material-symbols-outlined text-3xl text-muted-foreground animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configure AI providers for embedding, LLM, and vision processing."
      />

      <div className="flex flex-col gap-6">
        <EmbeddingSettingsCard />

        <LlmCatalogCard renderMeta={llmMeta} />

        <ModelCatalogCard
          title="Vision Model"
          description="Used for image analysis during document ingestion."
          icon="visibility"
          catalogUrl="/api/settings/vision/catalog"
          switchUrl="/api/settings/vision/switch"
          apiKeyConfigKey="vision_api_key"
          renderMeta={visionMeta}
        />

        <NotificationChannelsCard />
      </div>
    </>
  );
}
