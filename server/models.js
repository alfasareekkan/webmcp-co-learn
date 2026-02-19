// Multi-model support — factory for Gemini, Claude, and OpenAI via LangChain

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";

// ---------------------------------------------------------------------------
// Available providers and their models
// ---------------------------------------------------------------------------
export const PROVIDERS = {
  gemini: {
    name: "Gemini",
    models: {
      "gemini-2.5-flash": { label: "Gemini 2.5 Flash", tier: "free" },
      "gemini-2.5-flash-lite": { label: "Gemini 2.5 Flash Lite", tier: "free" },
      "gemini-2.0-flash": { label: "Gemini 2.0 Flash", tier: "free" },
    },
    envKey: "GEMINI_API_KEY",
  },
  anthropic: {
    name: "Claude",
    models: {
      "claude-sonnet-4-20250514": { label: "Claude Sonnet 4", tier: "paid" },
      "claude-3-5-haiku-20241022": { label: "Claude 3.5 Haiku", tier: "cheap" },
    },
    envKey: "ANTHROPIC_API_KEY",
  },
  openai: {
    name: "OpenAI",
    models: {
      "gpt-4o-mini": { label: "GPT-4o Mini", tier: "cheap" },
      "gpt-4o": { label: "GPT-4o", tier: "paid" },
      "gpt-4.1-mini": { label: "GPT-4.1 Mini", tier: "cheap" },
      "gpt-4.1-nano": { label: "GPT-4.1 Nano", tier: "free" },
    },
    envKey: "OPENAI_API_KEY",
  },
};

// ---------------------------------------------------------------------------
// Detect which providers have API keys configured
// ---------------------------------------------------------------------------
export function getAvailableProviders() {
  const available = [];
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const apiKey = process.env[provider.envKey];
    if (apiKey) {
      available.push({
        id,
        name: provider.name,
        models: Object.entries(provider.models).map(([modelId, info]) => ({
          id: modelId,
          label: info.label,
          tier: info.tier,
          provider: id,
        })),
      });
    }
  }
  return available;
}

// ---------------------------------------------------------------------------
// Create a LangChain chat model for any provider
// ---------------------------------------------------------------------------
export function createChatModel(provider, modelId, options = {}) {
  const temperature = options.temperature ?? 0;
  const maxRetries = options.maxRetries ?? 2;

  switch (provider) {
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY not set");
      return new ChatGoogleGenerativeAI({
        model: modelId,
        apiKey,
        temperature,
        maxRetries,
      });
    }

    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      return new ChatAnthropic({
        model: modelId,
        anthropicApiKey: apiKey,
        temperature,
        maxRetries,
      });
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      return new ChatOpenAI({
        model: modelId,
        openAIApiKey: apiKey,
        temperature,
        maxRetries,
      });
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// Get the default model (first available provider, best free model)
// ---------------------------------------------------------------------------
export function getDefaultModel() {
  if (process.env.GEMINI_API_KEY) return { provider: "gemini", model: "gemini-2.5-flash" };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", model: "gpt-4o-mini" };
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", model: "claude-3-5-haiku-20241022" };
  return null;
}

// Lighter model for guidance (cheaper, faster)
export function getGuidanceModel() {
  if (process.env.GEMINI_API_KEY) return { provider: "gemini", model: "gemini-2.5-flash-lite" };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", model: "gpt-4o-mini" };
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", model: "claude-3-5-haiku-20241022" };
  return null;
}
