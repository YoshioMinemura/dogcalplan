import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase-config.js";

const LIBRARY_URL = "./vendor/supabase.min.js";
let clientPromise;

function loadLibrary() {
  if (globalThis.supabase?.createClient) return Promise.resolve(globalThis.supabase);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-supabase-client]');
    if (existing) {
      existing.addEventListener("load", () => resolve(globalThis.supabase), { once: true });
      existing.addEventListener("error", () => reject(new Error("同期ライブラリを読み込めません")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = LIBRARY_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.supabaseClient = "true";
    script.onload = () => globalThis.supabase?.createClient
      ? resolve(globalThis.supabase)
      : reject(new Error("同期ライブラリを初期化できません"));
    script.onerror = () => reject(new Error("同期ライブラリを読み込めません"));
    document.head.appendChild(script);
  });
}

export function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = loadLibrary().then(({ createClient }) => createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
    ));
  }
  return clientPromise;
}
