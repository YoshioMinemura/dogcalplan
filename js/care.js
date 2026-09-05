import { getSupabaseClient } from "./supabase-client.js";
import { VAPID_PUBLIC_KEY } from "./push-config.js";

export const EYE_DROP_TIMES = ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"];

const clone = (value) => JSON.parse(JSON.stringify(value));

export function secondsUntil(iso, now = Date.now()) {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
}

export function formatCountdown(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function validateEyeDropSettings(dropTypes, templates) {
  const ids = new Set();
  const names = new Set();
  const times = new Set();
  const errors = [];
  for (const type of dropTypes || []) {
    const name = String(type.name || "").trim();
    if (!type.id || !name) errors.push("点眼薬の名称を入力してください。");
    if (ids.has(type.id)) errors.push("点眼薬IDが重複しています。");
    if (names.has(name)) errors.push("点眼薬の表示名が重複しています。");
    if (!Number.isInteger(Number(type.requiredDailyCount)) || Number(type.requiredDailyCount) < 0) {
      errors.push("1日必要回数は0以上の整数で入力してください。");
    }
    ids.add(type.id);
    names.add(name);
  }
  const actual = new Map([...ids].map((id) => [id, 0]));
  for (const template of templates || []) {
    if (!EYE_DROP_TIMES.includes(template.time)) errors.push(`${template.time}は使用できない点眼時刻です。`);
    if (times.has(template.time)) errors.push("点眼時刻が重複しています。");
    times.add(template.time);
    for (const id of template.steps || []) {
      if (!ids.has(id)) errors.push(`${template.time}に存在しない点眼薬が指定されています。`);
      else actual.set(id, actual.get(id) + 1);
    }
  }
  const countWarnings = (dropTypes || []).flatMap((type) => {
    const required = Number(type.requiredDailyCount || 0);
    const scheduled = actual.get(type.id) || 0;
    return required !== scheduled ? [`点眼${type.name}: 必要${required}回／予定${scheduled}回`] : [];
  });
  return { errors: [...new Set(errors)], countWarnings, counts: Object.fromEntries(actual) };
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

function friendlyCareError(error) {
  const message = error?.message || "介護データを更新できませんでした";
  if (/admin required/i.test(message)) return "この設定は管理者だけが変更できます";
  if (/already claimed by (.+)/i.test(message)) return `この回はすでに${message.match(/already claimed by (.+)/i)?.[1] || "別の家族"}が対応中です`;
  if (/operator only/i.test(message)) return "点眼を完了できるのは現在の担当者だけです";
  if (/too early/i.test(message)) return "5分間隔が経過するまで次の点眼は完了できません";
  if (/fetch|network|offline/i.test(message)) return "オンライン接続が必要です";
  return message;
}

export function createCareFeatures({ timezone, localDate, onChange, onMessage }) {
  let client;
  let channel;
  let initializing = null;
  let householdId = null;
  let userId = null;
  const state = {
    ready: false,
    loading: false,
    profile: null,
    healthEvents: [],
    eyeDropSettings: null,
    eyeDropSessions: [],
    notificationPreferences: {
      master_enabled: false,
      scheduled_eye_drop_enabled: true,
      active_eye_drop_timer_enabled: true
    },
    error: ""
  };

  const emit = () => onChange?.(getSnapshot());
  const requireOnline = () => {
    if (!navigator.onLine) throw new Error("この操作はオンライン接続中に行ってください");
  };

  async function load() {
    if (!householdId) return;
    const date = localDate();
    await client.rpc("ensure_eye_drop_sessions", { p_local_date: date, p_timezone: timezone() });
    const [healthResult, settingsResult, sessionsResult, preferencesResult] = await Promise.all([
      client.from("health_events").select("*").eq("household_id", householdId).order("occurred_at", { ascending: false }).limit(200),
      client.from("eye_drop_settings").select("*").eq("household_id", householdId).single(),
      client.from("eye_drop_sessions").select("*,eye_drop_steps(*)").eq("household_id", householdId)
        .order("local_date", { ascending: false }).order("scheduled_time").limit(500),
      client.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle()
    ]);
    for (const result of [healthResult, settingsResult, sessionsResult, preferencesResult]) {
      if (result.error) throw result.error;
    }
    state.healthEvents = healthResult.data || [];
    state.eyeDropSettings = settingsResult.data;
    state.eyeDropSessions = (sessionsResult.data || []).map((session) => ({
      ...session,
      eye_drop_steps: [...(session.eye_drop_steps || [])].sort((a, b) => a.step_order - b.step_order)
    }));
    if (preferencesResult.data) state.notificationPreferences = preferencesResult.data;
    state.ready = true;
    state.error = "";
    emit();
  }

  function subscribe() {
    if (channel) client.removeChannel(channel);
    channel = client.channel(`care:${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "health_events", filter: `household_id=eq.${householdId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "eye_drop_sessions", filter: `household_id=eq.${householdId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "eye_drop_steps" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "eye_drop_settings", filter: `household_id=eq.${householdId}` }, load)
      .subscribe();
  }

  async function initialize(displayName = "") {
    if (state.ready && householdId && !displayName) return;
    if (initializing) return initializing;
    initializing = (async () => {
      state.loading = true;
      emit();
      try {
        client = await getSupabaseClient();
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        userId = sessionData.session?.user?.id;
        if (!userId) throw new Error("匿名セッションを確認できません");
        const { data, error } = await client.rpc("ensure_care_profile", { p_display_name: displayName || null });
        if (error) throw error;
        state.profile = data?.[0] || null;
        householdId = state.profile?.household_id;
        if (!householdId) throw new Error("家族データを確認できません");
        await load();
        subscribe();
      } catch (error) {
        state.error = friendlyCareError(error);
        state.ready = false;
        onMessage?.(state.error);
        emit();
      } finally {
        state.loading = false;
        initializing = null;
        emit();
      }
    })();
    return initializing;
  }

  async function mutate(rpc, parameters) {
    requireOnline();
    const { error } = await client.rpc(rpc, parameters);
    if (error) throw new Error(friendlyCareError(error));
    await load();
  }

  async function recordHealth(eventType) {
    const id = crypto.randomUUID();
    await mutate("record_health_event", {
      p_id: id,
      p_event_type: eventType,
      p_occurred_at: new Date().toISOString()
    });
    return id;
  }

  const voidHealth = (id) => mutate("void_health_event", { p_event_id: id });
  const claimSession = (id) => mutate("claim_eye_drop_session", { p_session_id: id });
  const completeStep = (id) => mutate("complete_eye_drop_step", { p_step_id: id });
  const takeoverSession = (id) => mutate("takeover_eye_drop_session", { p_session_id: id });

  async function saveEyeDropSettings(dropTypes, templates, intervalSeconds) {
    const validation = validateEyeDropSettings(dropTypes, templates);
    if (validation.errors.length) throw new Error(validation.errors[0]);
    await mutate("save_eye_drop_settings", {
      p_drop_types: dropTypes,
      p_templates: templates,
      p_interval_seconds: intervalSeconds
    });
    return validation;
  }

  async function saveDisplayName(displayName) {
    const name = String(displayName || "").trim();
    if (!name) throw new Error("表示名を入力してください");
    const { data, error } = await client.rpc("ensure_care_profile", { p_display_name: name });
    if (error) throw new Error(friendlyCareError(error));
    state.profile = data?.[0] || state.profile;
    emit();
  }

  async function saveNotificationPreferences(preferences) {
    requireOnline();
    const { data, error } = await client.rpc("save_notification_preferences", {
      p_master_enabled: Boolean(preferences.master_enabled),
      p_scheduled_enabled: Boolean(preferences.scheduled_eye_drop_enabled),
      p_timer_enabled: Boolean(preferences.active_eye_drop_timer_enabled)
    });
    if (error) throw new Error(friendlyCareError(error));
    state.notificationPreferences = data;
    emit();
  }

  async function enablePush() {
    requireOnline();
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("この環境はWeb Pushに対応していません");
    }
    if (!VAPID_PUBLIC_KEY) throw new Error("VAPID公開鍵が未設定です。運用手順書に従って設定してください");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("端末側で通知が許可されていません");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    const json = subscription.toJSON();
    const { error } = await client.rpc("register_push_subscription", {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys?.p256dh,
      p_auth: json.keys?.auth
    });
    if (error) throw new Error(friendlyCareError(error));
    await saveNotificationPreferences({ ...state.notificationPreferences, master_enabled: true });
  }

  async function exportCareData() {
    requireOnline();
    if (!householdId) throw new Error("家族データへの接続後に出力してください");
    const pageSize = 1000;
    const fetchAll = async (makeQuery) => {
      const rows = [];
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await makeQuery().range(from, from + pageSize - 1);
        if (error) throw new Error(friendlyCareError(error));
        rows.push(...(data || []));
        if (!data || data.length < pageSize) return rows;
      }
    };
    const [healthEvents, eyeDropSessions] = await Promise.all([
      fetchAll(() => client.from("health_events").select("*").eq("household_id", householdId)
        .order("occurred_at", { ascending: false })),
      fetchAll(() => client.from("eye_drop_sessions").select("*,eye_drop_steps(*)").eq("household_id", householdId)
        .order("local_date", { ascending: false }).order("scheduled_time"))
    ]);
    return clone({
      format: "dogcalplan-care-export",
      exportedAt: new Date().toISOString(),
      householdId,
      profile: state.profile,
      eyeDropSettings: state.eyeDropSettings,
      notificationPreferences: state.notificationPreferences,
      healthEvents,
      eyeDropSessions: eyeDropSessions.map((session) => ({
        ...session,
        eye_drop_steps: [...(session.eye_drop_steps || [])].sort((a, b) => a.step_order - b.step_order)
      }))
    });
  }

  function getSnapshot() {
    return clone({
      ...state,
      householdId,
      userId,
      online: navigator.onLine,
      notificationPermission: globalThis.Notification?.permission || "unsupported",
      pushConfigured: Boolean(VAPID_PUBLIC_KEY)
    });
  }

  addEventListener("online", () => householdId && load().catch(() => {}));
  addEventListener("offline", emit);

  return {
    initialize,
    reload: load,
    recordHealth,
    voidHealth,
    claimSession,
    completeStep,
    takeoverSession,
    saveEyeDropSettings,
    saveDisplayName,
    saveNotificationPreferences,
    enablePush,
    exportCareData,
    getSnapshot
  };
}
