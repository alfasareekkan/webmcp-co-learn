/**
 * Supabase helper — persists API keys so they survive Railway restarts.
 *
 * Table schema (run once in Supabase SQL editor):
 *
 *   create table api_keys (
 *     id          text primary key default 'singleton',
 *     gemini      text,
 *     openai      text,
 *     anthropic   text,
 *     updated_at  timestamptz default now()
 *   );
 *   alter table api_keys enable row level security;
 *   create policy "allow_all" on api_keys for all using (true) with check (true);
 *   insert into api_keys (id) values ('singleton') on conflict do nothing;
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL
  || "https://jktyphagkzgbbteeazmg.supabase.co";

const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY
  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprdHlwaGFna3pnYmJ0ZWVhem1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3MjYzODYsImV4cCI6MjA4NjMwMjM4Nn0.AkE_vsbLnfRW4Pq8e8UXoi8OCboVAvNHm9j-NBIpCPE";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Load stored API keys from Supabase.
 * Returns { gemini?, openai?, anthropic? } — missing fields are undefined/null.
 */
export async function loadApiKeys() {
  try {
    const { data, error } = await supabase
      .from("api_keys")
      .select("gemini, openai, anthropic")
      .eq("id", "singleton")
      .single();

    if (error) {
      console.warn("[Supabase] loadApiKeys:", error.message);
      return {};
    }
    return data || {};
  } catch (err) {
    console.warn("[Supabase] loadApiKeys error:", err.message);
    return {};
  }
}

/**
 * Persist API keys to Supabase (upsert the singleton row).
 * Pass null/undefined for a provider to clear it.
 */
export async function saveApiKeys({ gemini, openai, anthropic }) {
  try {
    const { error } = await supabase
      .from("api_keys")
      .upsert({
        id:         "singleton",
        gemini:     gemini     || null,
        openai:     openai     || null,
        anthropic:  anthropic  || null,
        updated_at: new Date().toISOString(),
      });

    if (error) console.error("[Supabase] saveApiKeys:", error.message);
    else       console.log("[Supabase] API keys saved.");
  } catch (err) {
    console.error("[Supabase] saveApiKeys error:", err.message);
  }
}
