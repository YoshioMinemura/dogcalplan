import { DEFAULT_SETTINGS, EVENT_LABELS, STATUS_LABELS, SCHEMA_VERSION } from "./defaults.js";
import {
  clone, createDay, createEvent, createInitialState, eventNutrition, formatDateJa, formatKcal,
  localDateInTimezone, medicineSchedule, migrateStateToCurrent, recalculatePlan, reasonForType, summarizeDay, timeInTimezone, uid
} from "./domain.js";
import { clearState, loadState, saveState } from "./db.js";
import { createFamilySync } from "./sync.js";
import { createCareFeatures, EYE_DROP_TIMES, formatCountdown, secondsUntil, validateEyeDropSettings } from "./care.js";

const todayView = document.querySelector("#today-view");
const eyedropsView = document.querySelector("#eyedrops-view");
const historyView = document.querySelector("#history-view");
const settingsView = document.querySelector("#settings-view");
const saveStatus = document.querySelector("#save-status");
const dialog = document.querySelector("#action-dialog");
const dialogContent = document.querySelector("#dialog-content");
const actionForm = document.querySelector("#action-form");
const toast = document.querySelector("#toast");

let state;
let targetEyeSessionId = new URLSearchParams(location.search).get("eyeSession");
let route = targetEyeSessionId ? "eyedrops" : "today";
let selectedHistoryDayId = null;
let pendingDialogAction = null;
let toastTimer = null;
let undoAction = null;
let mutationLocked = false;
let volatileMode = false;
let installPromptEvent = null;
let familySync = null;
let careFeatures = null;
let pendingDisplayName = "";
let careView = {
  ready: false, loading: false, profile: null, healthEvents: [], eyeDropSettings: null,
  eyeDropSessions: [], notificationPreferences: {}, error: "", online: navigator.onLine
};
let syncView = { phase: "initializing", message: "同期を確認中…", error: false, connected: false, pending: false, conflicts: [], inviteUrl: "" };

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPromptEvent = event;
  if (route === "today" && state) renderToday();
});

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const parseIso = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

function currentDay() {
  const date = localDateInTimezone(new Date(), state.settings.timezone);
  return state.days.find((day) => day.localDate === date);
}

function displayTime(iso, timezone) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(parseIso(iso));
}

function datetimeLocalValue(iso = new Date().toISOString()) {
  const date = parseIso(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function percent(value, target) {
  return Math.max(0, Math.min(100, target ? (value / target) * 100 : 0));
}

function actorFields() {
  return {
    recordedByUserId: careView.userId || undefined,
    recordedByName: careView.profile?.display_name || undefined
  };
}

function alertHtml(warning) {
  const icon = warning.level === "critical" ? "!" : warning.level === "caution" ? "△" : "i";
  return `<div class="alert ${warning.level}" role="${warning.level === "critical" ? "alert" : "status"}">
    <span class="alert-icon" aria-hidden="true">${icon}</span>
    <div><strong>${escapeHtml(warning.title)}</strong><p>${escapeHtml(warning.message)}</p></div>
  </div>`;
}

function installHelpHtml() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  let dismissed = false;
  try { dismissed = localStorage.getItem("dogcare-install-help-dismissed") === "1"; } catch { /* no-op */ }
  if (standalone || dismissed) return "";
  const isiOS = new RegExp("iPad|iPhone|iPod").test(navigator.userAgent);
  const message = isiOS
    ? "Safariの共有ボタンから「ホーム画面に追加」を選ぶと、オフラインでもすぐ開けます。"
    : installPromptEvent ? "ホーム画面へ追加すると、オフラインでもアプリのように開けます。" : "ブラウザのメニューから「ホーム画面に追加」または「アプリをインストール」を選べます。";
  return `<div class="alert info install-help"><span class="alert-icon" aria-hidden="true">＋</span><div><strong>ホーム画面に追加</strong><p>${message}</p><div class="slot-actions">${installPromptEvent ? '<button type="button" class="mini-btn give" data-action="install-app">追加する</button>' : ""}<button type="button" class="mini-btn" data-action="dismiss-install">閉じる</button></div></div></div>`;
}

function syncAlertsHtml() {
  const alerts = [];
  if (syncView.conflicts?.length) alerts.push(alertHtml({
    level: "critical",
    title: "家族間の同時操作を調整しました",
    message: syncView.conflicts[0]
  }));
  if (syncView.connected && syncView.pending && !navigator.onLine) alerts.push(alertHtml({
    level: "caution",
    title: "オフライン・同期待ち",
    message: "記録はこの端末に保存済みです。通信が戻ると家族へ自動送信します。"
  }));
  return alerts.join("");
}

function syncSettingsHtml() {
  const connected = syncView.connected;
  const statusClass = syncView.error ? "critical" : connected ? "info" : "caution";
  const invite = syncView.inviteUrl;
  return `<div class="section-heading"><h3>家族間同期</h3><span>${connected ? "Supabase" : "端末内のみ"}</span></div>
    <section class="settings-section sync-panel">
      <div class="alert ${statusClass}"><span class="alert-icon" aria-hidden="true">${syncView.error ? "!" : connected ? "✓" : "i"}</span><div><strong>${escapeHtml(syncView.message)}</strong><p>${connected ? "記録は端末にも保存され、オンライン時に家族へ同期されます。" : "家族と共有するには、最初の1台で同期を開始してください。"}</p></div></div>
      ${connected ? `<div class="button-row"><button type="button" class="button" data-action="sync-now">今すぐ同期</button>${syncView.conflicts?.length ? '<button type="button" class="button" data-action="clear-sync-conflicts">警告を確認済みにする</button>' : ""}</div>` : '<div class="button-row"><button type="button" class="button primary" data-action="start-family-sync">この端末のデータで家族同期を開始</button></div>'}
      ${invite ? `<div class="field full invite-field"><label for="family-invite-url">家族へ送る招待URL</label><textarea id="family-invite-url" readonly rows="3">${escapeHtml(invite)}</textarea><span class="field-help">このURLを知っている人は家族データへ参加できます。SNSや公開Issueには貼らないでください。</span><button type="button" class="button" data-action="copy-invite">招待URLをコピー</button></div>` : connected ? '<p class="field-help">この端末には招待トークンが残っていません。最初に同期を開始した端末から招待URLを共有してください。</p>' : ""}
    </section>`;
}

function getNextPlan(day) {
  return day.slots
    .filter((slot) => slot.status === "PLANNED")
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))[0] || null;
}

function getBalanceRecordTarget(day) {
  return day.slots
    .filter((slot) => ["OVERDUE", "PLANNED"].includes(slot.status))
    .sort((left, right) => {
      const priority = Number(right.status === "OVERDUE") - Number(left.status === "OVERDUE");
      return priority || left.scheduledTime.localeCompare(right.scheduledTime);
    })[0] || null;
}

function joinFamilyHtml() {
  return `<div class="join-gate">
    <div class="page-heading"><div><h2 id="today-title">家族データに参加</h2><p>このホーム画面版では、初回だけ招待URLの貼り付けが必要です。</p></div></div>
    <section class="settings-section">
      <div class="alert caution"><span class="alert-icon" aria-hidden="true">i</span><div><strong>まだ家族と同期されていません</strong><p>メッセージ等で受け取った完全な招待URLを貼り付けてください。参加後は、次回からホーム画面のアイコンを押すだけで自動同期します。</p></div></div>
      <form id="join-family-form" class="join-form">
        <div class="field full"><label for="join-display-name">あなたの表示名</label><input id="join-display-name" name="displayName" maxlength="60" required placeholder="例：母"></div>
        <div class="field full"><label for="join-invite-url">招待URL</label><textarea id="join-invite-url" name="invite" rows="4" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…/#invite=…"></textarea></div>
        <div class="button-row"><button type="submit" class="button primary">家族データに参加</button></div>
      </form>
      <p class="field-help">参加が完了するまで、この端末から新しい記録は追加されません。</p>
      <button type="button" class="link-button" data-route="settings">最初の家族データを作る場合は設定へ</button>
    </section>
  </div>`;
}

function setSaveStatus(message, error = false) {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error", error);
}

async function persist() {
  state.updatedAt = new Date().toISOString();
  if (volatileMode) return;
  setSaveStatus("保存中…");
  try {
    await saveState(state);
    setSaveStatus(familySync?.isConnected() ? "端末保存・同期待ち" : "端末内に保存済み");
    await familySync?.queue();
  } catch (error) {
    volatileMode = true;
    setSaveStatus("保存できません", true);
    showToast("保存に失敗しました。この画面を閉じる前にJSONを出力してください。");
    console.error(error);
  }
}

async function commit({ render = true } = {}) {
  await persist();
  if (render) renderApp();
}

function showToast(message, onUndo = null) {
  clearTimeout(toastTimer);
  undoAction = onUndo;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>${onUndo ? '<button type="button" data-action="undo">元に戻す</button>' : ""}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; undoAction = null; }, onUndo ? 8000 : 4500);
}

async function withMutationLock(callback) {
  if (mutationLocked) return;
  mutationLocked = true;
  try { await callback(); } finally { setTimeout(() => { mutationLocked = false; }, 500); }
}

function renderApp() {
  todayView.hidden = route !== "today";
  eyedropsView.hidden = route !== "eyedrops";
  historyView.hidden = route !== "history";
  settingsView.hidden = route !== "settings";
  document.querySelectorAll("[data-route]").forEach((button) => {
    const active = button.dataset.route === route;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (route === "today") renderToday();
  if (route === "eyedrops") renderEyeDrops();
  if (route === "history") renderHistory();
  if (route === "settings") renderSettings();
}

function currentHealthEvents() {
  const timezone = state?.settings?.timezone || "Asia/Tokyo";
  const date = localDateInTimezone(new Date(), timezone);
  return (careView.healthEvents || []).filter((item) => item.status === "ACTIVE"
    && localDateInTimezone(parseIso(item.occurred_at), timezone) === date);
}

function currentEyeSessions() {
  const date = localDateInTimezone(new Date(), state?.settings?.timezone || "Asia/Tokyo");
  return (careView.eyeDropSessions || []).filter((session) => session.local_date === date)
    .sort((left, right) => String(left.scheduled_time).localeCompare(String(right.scheduled_time)));
}

function healthQuickHtml() {
  if (!careView.ready) return careView.error
    ? `<div class="alert critical"><span class="alert-icon">!</span><div><strong>介護機能を準備できません</strong><p>${escapeHtml(careView.error)}。新しいSupabase migrationの適用を確認してください。</p></div></div>`
    : '<div class="panel care-loading" role="status">点眼・排泄データを確認中…</div>';
  const events = currentHealthEvents();
  const latest = (type) => events.find((item) => item.event_type === type);
  const urine = latest("urine");
  const stool = latest("stool");
  const offline = !careView.online;
  return `<section class="care-section" aria-labelledby="health-title">
    <div class="section-heading"><h3 id="health-title">排泄</h3><span>${offline ? "オンライン復帰後に記録" : "家族へ即時共有"}</span></div>
    <div class="health-actions">
      <button type="button" class="health-button urine" data-health="urine"${offline ? " disabled" : ""}><strong>小</strong><small>現在時刻で記録</small></button>
      <button type="button" class="health-button stool" data-health="stool"${offline ? " disabled" : ""}><strong>大</strong><small>現在時刻で記録</small></button>
    </div>
    <p class="health-latest">最終　小 ${urine ? displayTime(urine.occurred_at, state.settings.timezone) : "—"}　／　大 ${stool ? displayTime(stool.occurred_at, state.settings.timezone) : "—"}</p>
  </section>`;
}

function eyeSessionCardHtml(session, compact = false) {
  const steps = session.eye_drop_steps || [];
  const completed = steps.filter((step) => step.status === "completed").length;
  const nextStep = steps.find((step) => step.status !== "completed" && step.status !== "cancelled");
  const remaining = secondsUntil(nextStep?.available_at);
  const mine = session.operator_user_id && session.operator_user_id === careView.userId;
  const offline = !careView.online;
  const statusLabel = session.status === "completed" ? "✓ 完了"
    : session.status === "in_progress" ? "● 進行中" : session.status === "cancelled" ? "― 中止" : "○ 未実施";
  let action = "";
  if (!steps.length) action = '<span class="slot-meta">点眼内容が未設定です</span>';
  else if (session.status === "pending") {
    action = `<button type="button" class="button primary" data-eye-claim="${session.id}"${offline ? " disabled" : ""}>この回を担当する</button>`;
  } else if (session.status === "in_progress" && nextStep && mine) {
    action = remaining > 0
      ? `<button type="button" class="button" disabled>点眼${escapeHtml(nextStep.drop_name)}まで ${formatCountdown(remaining)}</button>`
      : `<button type="button" class="button primary" data-eye-complete="${nextStep.id}"${offline ? " disabled" : ""}>点眼${escapeHtml(nextStep.drop_name)} 完了</button>`;
  } else if (session.status === "in_progress" && !mine) {
    action = `<button type="button" class="button" data-eye-takeover="${session.id}"${offline ? " disabled" : ""}>担当を引き継ぐ</button>`;
  }
  return `<article data-eye-session-id="${session.id}" class="eye-session ${session.status}${compact ? " compact" : ""}">
    <div class="eye-session-head"><strong>${String(session.scheduled_time).slice(0, 5)} 点眼</strong><span>${statusLabel}</span></div>
    <p class="slot-meta">${steps.map((step) => `${escapeHtml(step.drop_name)}${step.status === "completed" ? " ✓" : ""}`).join(" → ") || "点眼設定なし"}</p>
    ${session.operator_display_name ? `<p class="eye-operator">担当: ${escapeHtml(session.operator_display_name)}　${completed}/${steps.length}</p>` : ""}
    ${nextStep && session.status === "in_progress" ? `<p class="eye-next">次: 点眼${escapeHtml(nextStep.drop_name)}${remaining ? `（あと ${formatCountdown(remaining)}）` : "（実施できます）"}</p>` : ""}
    ${compact ? "" : `<div class="button-row">${action}</div>`}
  </article>`;
}

function eyeTodayHtml() {
  if (!careView.ready) return "";
  const sessions = currentEyeSessions();
  const active = sessions.find((session) => session.status === "in_progress");
  const next = active || sessions.find((session) => !["completed", "cancelled"].includes(session.status));
  if (!next) return '<section class="eye-overview completed"><strong>本日の点眼は完了しました</strong></section>';
  return `<section class="eye-overview ${active ? "active" : ""}">
    <div class="section-heading"><h3>${active ? "進行中の点眼" : "次回の点眼"}</h3><button type="button" class="link-button" data-route="eyedrops">一覧を見る</button></div>
    ${eyeSessionCardHtml(next)}
  </section>`;
}

function renderEyeDrops() {
  if (!careView.ready) {
    eyedropsView.innerHTML = `<div class="page-heading"><div><h2 id="eyedrops-title">点眼</h2></div></div>${healthQuickHtml()}`;
    return;
  }
  const sessions = currentEyeSessions();
  eyedropsView.innerHTML = `
    <div class="page-heading"><div><h2 id="eyedrops-title">今日の点眼</h2><p>担当取得と完了操作はオンライン必須です</p></div><span class="date-chip">${careView.online ? "オンライン" : "オフライン"}</span></div>
    ${!careView.online ? alertHtml({ level: "caution", title: "現在オフラインです", message: "共有状態が最新ではない可能性があります。点眼操作はオンライン復帰後に行ってください。" }) : ""}
    <div class="eye-session-list">${sessions.length ? sessions.map((session) => eyeSessionCardHtml(session)).join("") : '<div class="empty-state">本日の点眼セッションはありません。設定画面で点眼内容を登録してください。</div>'}</div>`;
  if (targetEyeSessionId && sessions.some((session) => session.id === targetEyeSessionId)) {
    const target = eyedropsView.querySelector(`[data-eye-session-id="${targetEyeSessionId}"]`);
    targetEyeSessionId = null;
    requestAnimationFrame(() => target?.scrollIntoView({ block: "center" }));
  }
}

function careSettingsHtml() {
  if (!careView.ready) return `<div class="section-heading"><h3>点眼・排泄</h3></div>${healthQuickHtml()}`;
  const profile = careView.profile || {};
  const preferences = careView.notificationPreferences || {};
  const eye = careView.eyeDropSettings || { drop_types: [], templates: [], interval_seconds: 300 };
  const typesText = (eye.drop_types || []).map((item) => `${item.id}|${item.name}|${item.requiredDailyCount || 0}`).join("\n");
  const typeNames = new Map((eye.drop_types || []).map((item) => [item.id, item.name]));
  const scheduleText = EYE_DROP_TIMES.map((time) => {
    const template = (eye.templates || []).find((item) => item.time === time);
    return `${time}=${(template?.steps || []).map((id) => typeNames.get(id) || id).join(",")}`;
  }).join("\n");
  return `<div class="section-heading"><h3>個人・通知設定</h3><span>${profile.role === "admin" ? "管理者" : "メンバー"}</span></div>
    <form id="care-profile-form" class="settings-section settings-form">
      <div class="field"><label for="care-display-name">あなたの表示名</label><input id="care-display-name" name="displayName" maxlength="60" value="${escapeHtml(profile.display_name || "")}" required></div>
      <label class="check-field"><input name="master" type="checkbox" ${preferences.master_enabled ? "checked" : ""}> すべての通知</label>
      <label class="check-field"><input name="scheduled" type="checkbox" ${preferences.scheduled_eye_drop_enabled ? "checked" : ""}> 定時点眼通知</label>
      <label class="check-field"><input name="timer" type="checkbox" ${preferences.active_eye_drop_timer_enabled ? "checked" : ""}> 担当中の次回点眼通知</label>
      <p class="field-help">端末の通知権限: ${escapeHtml(careView.notificationPermission)} ／ Push設定: ${careView.pushConfigured ? "設定済み" : "VAPID公開鍵が未設定"}</p>
      <div class="button-row"><button type="button" class="button" data-action="enable-push">この端末で通知を許可</button><button type="submit" class="button primary">個人設定を保存</button></div>
    </form>
    <div class="section-heading"><h3>点眼設定</h3><span>変更は翌日以降</span></div>
    ${profile.role !== "admin" ? '<div class="panel"><p class="slot-meta">点眼設定は管理者だけが変更できます。</p></div>' : `<form id="eye-settings-form" class="settings-section settings-form">
      <div class="field"><label>点眼薬（1行ごとに ID|表示名|1日必要回数）</label><textarea name="dropTypes" rows="6" required>${escapeHtml(typesText)}</textarea></div>
      <div class="field"><label>時刻別スケジュール（表示名をカンマ区切り）</label><textarea name="templates" rows="11" required>${escapeHtml(scheduleText)}</textarea></div>
      <div class="field"><label>点眼間隔（分）</label><input name="intervalMinutes" type="number" min="1" max="60" step="1" value="${Math.round(eye.interval_seconds / 60)}" required></div>
      <p class="field-help">必要回数と予定回数が違う場合は保存前に警告します。今日生成済みのセッションは変更しません。</p>
      <div class="button-row"><button type="submit" class="button primary">翌日以降の点眼設定を保存</button></div>
    </form>`}`;
}

function renderToday() {
  if (!syncView.connected) {
    todayView.innerHTML = syncView.phase === "initializing"
      ? '<div class="empty-state" role="status">家族データとの接続を確認しています…</div>'
      : joinFamilyHtml();
    return;
  }
  const day = currentDay();
  const summary = recalculatePlan(day, new Date(), "時刻更新");
  const settings = day.settingsSnapshot;
  const next = getNextPlan(day);
  const actualKcal = formatKcal(summary.actualCaloriesTenthKcal);
  const targetKcal = formatKcal(settings.calorieTargetTenthKcal);
  const remaining = Math.max(0, settings.calorieTargetTenthKcal - summary.actualCaloriesTenthKcal);
  const completedTotal = summary.completedBalanceLiquidDoses + summary.recommendedRemainingDoses;
  const recordTarget = getBalanceRecordTarget(day);
  const heroStatus = summary.actualCaloriesTenthKcal >= settings.calorieTargetTenthKcal
    ? `${formatKcal(summary.actualCaloriesTenthKcal - settings.calorieTargetTenthKcal)} kcal 超過`
    : `あと ${formatKcal(remaining)} kcal`;

  todayView.innerHTML = `
    <div class="page-heading">
      <div><h2 id="today-title">今日${settings.dogName ? `の${escapeHtml(settings.dogName)}` : ""}</h2><p>${formatDateJa(day.localDate)}</p></div>
      <span class="date-chip">予定は随時再計算</span>
    </div>
    ${eyeTodayHtml()}
    ${healthQuickHtml()}
    <section class="hero" aria-label="本日のカロリー">
      <p class="hero-label">摂取カロリー</p>
      <div class="hero-value"><strong>${actualKcal}</strong><span>/ ${targetKcal} kcal</span></div>
      <div class="progress" role="progressbar" aria-label="カロリー目標" aria-valuemin="0" aria-valuemax="${settings.calorieTargetTenthKcal}" aria-valuenow="${summary.actualCaloriesTenthKcal}"><span style="width:${percent(summary.actualCaloriesTenthKcal, settings.calorieTargetTenthKcal)}%"></span></div>
      <p class="hero-foot"><span>${heroStatus}</span><span>予定後 ${formatKcal(summary.predictedCaloriesTenthKcal)} kcal</span></p>
    </section>
    <div class="metric-grid" aria-label="本日の集計">
      <div class="metric-card"><span class="metric-label">実績水分</span><strong class="metric-value">${summary.actualWaterMl} / ${settings.waterLimitMl} ml</strong><span class="metric-note">実際に摂取</span></div>
      <div class="metric-card"><span class="metric-label">薬を含む見込み</span><strong class="metric-value">${summary.projectedCommittedWaterMl} ml</strong><span class="metric-note">安全残量 ${summary.safeRemainingWaterMl} ml</span></div>
      <div class="metric-card"><span class="metric-label">鶏ごはん</span><strong class="metric-value">${summary.chickenMealCount} 食</strong><span class="metric-note">1食 ${formatKcal(settings.foods.chickenMeal.caloriesTenthKcal)} kcal</span></div>
      <div class="metric-card"><span class="metric-label">${escapeHtml(settings.foods.balanceLiquid.name)}</span><strong class="metric-value">${summary.completedBalanceLiquidDoses} 回完了</strong><span class="metric-note">必要合計 ${completedTotal} 回</span></div>
    </div>
    <section class="next-card" aria-label="次回予定">
      <strong class="next-time">${next ? next.scheduledTime : "—"}</strong>
      <div><strong>${next ? escapeHtml(settings.foods.balanceLiquid.name) : "追加不要"}</strong><p>${next ? `${formatKcal(settings.foods.balanceLiquid.caloriesTenthKcal)} kcal・管理水分${settings.foods.balanceLiquid.countedWaterMl} ml` : summary.calorieReachable ? "現在の予定で目標に到達します" : "安全な追加予定はありません"}</p></div>
    </section>
    <div class="alerts">${syncAlertsHtml()}${summary.warnings.map(alertHtml).join("")}${installHelpHtml()}</div>

    <div class="section-heading"><h3>すぐに記録</h3><span>入力後すぐ反映</span></div>
    <div class="quick-grid">
      <button class="quick-action primary" type="button" data-action="record-balance"${recordTarget ? ` data-slot-id="${recordTarget.id}"` : ""}><strong>${escapeHtml(settings.foods.balanceLiquid.name)}を与えた</strong><small>${recordTarget ? `${recordTarget.scheduledTime}枠・` : "予定外・"}${formatKcal(settings.foods.balanceLiquid.caloriesTenthKcal)} kcal・管理水分${settings.foods.balanceLiquid.countedWaterMl} ml</small></button>
      <button class="quick-action water" type="button" data-record="PLAIN_WATER"><strong>普通の水を飲んだ</strong><small>飲水量だけ入力</small></button>
      <button class="quick-action solid" type="button" data-record="SOLID_FOOD"><strong>固形食を食べた</strong><small>カロリーだけ入力</small></button>
      <button class="quick-action chicken" type="button" data-record="CHICKEN_MEAL"><strong>${escapeHtml(settings.foods.chickenMeal.name)}を食べた</strong><small>${formatKcal(settings.foods.chickenMeal.caloriesTenthKcal)} kcal・水分${settings.foods.chickenMeal.countedWaterMl} ml</small></button>
      <button class="quick-action" type="button" data-record="VOMIT_BUSTER"><strong>${escapeHtml(settings.medicine.name)} ${settings.medicine.doseMl} ml</strong><small>残り予約と置き換え</small></button>
      <button class="quick-action" type="button" data-record="SOUP_SYRINGE"><strong>${escapeHtml(settings.foods.soupSyringe.name)}を与えた</strong><small>${formatKcal(settings.foods.soupSyringe.caloriesTenthKcal)} kcal・${settings.foods.soupSyringe.countedWaterMl} ml</small></button>
    </div>

    <div class="section-heading"><h3>今日のタイムライン</h3><span>6:00〜22:00</span></div>
    ${timelineHtml(day, true)}

    <div class="section-heading"><h3>今日のメモ</h3></div>
    <div class="note-box">
      <textarea id="day-note" maxlength="2000" placeholder="体調や獣医師からの指示など">${escapeHtml(day.note || "")}</textarea>
      <div class="note-footer"><button class="button" type="button" data-action="save-note" data-day-id="${day.id}">メモを保存</button></div>
    </div>`;
}

function timelineHtml(day, interactive) {
  const activeEvents = day.events.filter((event) => event.status === "ACTIVE");
  const linkedEvents = new Map(activeEvents.filter((event) => event.linkedSlotId).map((event) => [event.linkedSlotId, event]));
  const items = day.slots.map((slot) => ({ kind: "slot", time: slot.scheduledTime, sort: `${slot.scheduledTime}0`, slot }));
  const medication = medicineSchedule(day);
  medication.doses.forEach((dose) => items.push({ kind: "medicine", time: dose.scheduledTime, sort: `${dose.scheduledTime}1`, dose }));
  const scheduledMedicineIds = new Set(medication.doses.map((dose) => dose.event?.id).filter(Boolean));
  activeEvents.filter((event) => (!["BALANCE_LIQUID", "NORMAL_SET"].includes(event.type) || !event.linkedSlotId) && !scheduledMedicineIds.has(event.id)).forEach((event) => {
    const time = displayTime(event.occurredAt, day.timezone);
    items.push({ kind: "event", time, sort: `${time}2`, event });
  });
  items.sort((a, b) => a.sort.localeCompare(b.sort));
  return `<div class="timeline">${items.map((item) => {
    if (item.kind === "slot") return slotHtml(day, item.slot, linkedEvents.get(item.slot.id), interactive);
    if (item.kind === "medicine") return medicineScheduleHtml(day, item.dose, interactive);
    return eventHtml(day, item.event, interactive);
  }).join("")}</div>`;
}

function medicineScheduleHtml(day, dose, interactive) {
  const now = new Date();
  const today = localDateInTimezone(now, day.timezone);
  const currentTime = timeInTimezone(now, day.timezone);
  const isPastDay = day.localDate < today;
  const status = dose.event ? "COMPLETED" : (isPastDay || (day.localDate === today && dose.scheduledTime < currentTime)) ? "OVERDUE" : "PLANNED";
  const statusClass = status.toLowerCase();
  const medicine = day.settingsSnapshot.medicine;
  const meta = dose.event
    ? `記録 ${displayTime(dose.event.occurredAt, day.timezone)}・${dose.event.countedWaterMl} ml${dose.event.recordedByName ? `・${escapeHtml(dose.event.recordedByName)}` : ""}`
    : `${medicine.doseMl} ml・未投与分は水分枠に予約済み`;
  const action = dose.event
    ? `<button type="button" class="mini-btn" data-edit-event="${dose.event.id}" data-day-id="${day.id}">実績を編集</button>`
    : interactive ? `<button type="button" class="mini-btn give" data-record="VOMIT_BUSTER" data-medicine-time="${dose.scheduledTime}">与えた</button>` : "";
  return `<article class="slot-card medicine ${statusClass}">
    <time class="timeline-time">${dose.scheduledTime}</time>
    <div class="timeline-body">
      <div class="slot-top"><span class="slot-title">${escapeHtml(medicine.name)}</span><span class="status-badge ${statusClass}">${STATUS_LABELS[status]}</span></div>
      <p class="slot-meta">${meta}</p>
      ${action ? `<div class="slot-actions">${action}</div>` : ""}
    </div>
  </article>`;
}

function slotHtml(day, slot, event, interactive) {
  const balance = day.settingsSnapshot.foods.balanceLiquid;
  const statusClass = slot.status.toLowerCase();
  const available = ["PLANNED", "OVERDUE"].includes(slot.status);
  const unplannedAvailable = ["NOT_REQUIRED", "ADJUSTMENT_AVAILABLE"].includes(slot.status);
  let meta = slot.role === "ADJUSTMENT" ? "必要かつ安全な場合だけ使用" : `${formatKcal(balance.caloriesTenthKcal)} kcal・管理水分${balance.countedWaterMl} ml`;
  if (event) meta = `記録 ${displayTime(event.occurredAt, day.timezone)}・${formatKcal(event.caloriesTenthKcal)} kcal・${event.countedWaterMl} ml${event.recordedByName ? `・${escapeHtml(event.recordedByName)}` : ""}`;
  else if (slot.changeReason) meta += `・${escapeHtml(slot.changeReason)}`;
  const actions = !interactive ? (event ? `<button type="button" class="link-button" data-edit-event="${event.id}" data-day-id="${day.id}">編集</button>` : "") : `
    ${available ? `<button type="button" class="mini-btn give" data-slot-action="give" data-slot-id="${slot.id}">与えた</button><button type="button" class="mini-btn" data-slot-action="skip" data-slot-id="${slot.id}">スキップ</button><button type="button" class="mini-btn" data-slot-action="fail" data-slot-id="${slot.id}">失敗</button>` : ""}
    ${unplannedAvailable ? `<button type="button" class="mini-btn" data-slot-action="give" data-slot-id="${slot.id}">予定外に記録</button>` : ""}
    ${event ? `<button type="button" class="mini-btn" data-edit-event="${event.id}" data-day-id="${day.id}">実績を編集</button>` : ""}
    ${["SKIPPED", "FAILED"].includes(slot.status) ? `<button type="button" class="mini-btn" data-slot-action="reset" data-slot-id="${slot.id}">状態を戻す</button>` : ""}`;
  return `<article class="slot-card ${statusClass}">
    <time class="timeline-time">${slot.scheduledTime}</time>
    <div class="timeline-body">
      <div class="slot-top"><span class="slot-title">${slot.role === "ADJUSTMENT" ? `${escapeHtml(balance.name)}調整枠` : escapeHtml(balance.name)}</span><span class="status-badge ${statusClass}">${STATUS_LABELS[slot.status]}</span></div>
      <p class="slot-meta">${meta}</p>
      ${actions ? `<div class="slot-actions">${actions}</div>` : ""}
    </div>
  </article>`;
}

function eventHtml(day, event, interactive) {
  const className = event.type === "VOMIT_BUSTER" ? "medicine" : event.type === "SOUP_SYRINGE" ? "soup" : event.type === "PLAIN_WATER" ? "water" : event.type === "SOLID_FOOD" ? "solid" : "";
  const details = event.type === "PLAIN_WATER"
    ? `${event.countedWaterMl} ml`
    : event.type === "SOLID_FOOD"
      ? `${formatKcal(event.caloriesTenthKcal)} kcal`
      : `${formatKcal(event.caloriesTenthKcal)} kcal・${event.countedWaterMl} ml`;
  return `<article class="event-card ${className}">
    <time class="timeline-time">${displayTime(event.occurredAt, day.timezone)}</time>
    <div class="timeline-body">
      <div class="event-top"><div><strong class="slot-title">${escapeHtml(EVENT_LABELS[event.type] || event.type)}</strong><p class="slot-meta">${details}${event.recordedByName ? `・${escapeHtml(event.recordedByName)}` : ""}${event.note ? `・${escapeHtml(event.note)}` : ""}</p></div>
      <button type="button" class="link-button" data-edit-event="${event.id}" data-day-id="${day.id}">${interactive ? "編集" : "詳細"}</button></div>
    </div>
  </article>`;
}

function careHistoryHtml(day) {
  if (!careView.ready) return "";
  const health = (careView.healthEvents || []).filter((item) =>
    localDateInTimezone(parseIso(item.occurred_at), day.timezone) === day.localDate)
    .map((item) => ({
      time: item.occurred_at,
      html: `<strong>${item.event_type === "urine" ? "小" : "大"}${item.status === "VOIDED" ? "（取消し）" : ""}</strong>　${escapeHtml(item.recorded_by_name || "家族")}`
    }));
  const eye = (careView.eyeDropSessions || []).filter((session) => session.local_date === day.localDate)
    .flatMap((session) => (session.eye_drop_steps || []).filter((step) => step.status === "completed").map((step) => ({
      time: step.completed_at,
      html: `<strong>点眼${escapeHtml(step.drop_name)}</strong>　${escapeHtml(step.completed_by_name || session.operator_display_name || "家族")}`
    })));
  const items = [...health, ...eye].sort((left, right) => String(right.time).localeCompare(String(left.time)));
  return `<div class="section-heading"><h3>点眼・排泄履歴</h3><span>${items.length}件</span></div>
    <div class="panel care-history">${items.length ? items.map((item) => `<div><time>${displayTime(item.time, day.timezone)}</time><span>${item.html}</span></div>`).join("") : '<p class="slot-meta">点眼・排泄の記録はありません。</p>'}</div>`;
}

function renderHistory() {
  if (selectedHistoryDayId) {
    const day = state.days.find((item) => item.id === selectedHistoryDayId);
    if (day) return renderHistoryDetail(day);
    selectedHistoryDayId = null;
  }
  const days = [...state.days].sort((a, b) => b.localDate.localeCompare(a.localDate));
  historyView.innerHTML = `
    <div class="page-heading"><div><h2 id="history-title">日別履歴</h2><p>${syncView.connected ? "端末保存と家族同期を併用しています" : "すべて端末内に保存されています"}</p></div></div>
    <div class="history-list">${days.length ? days.map((day) => {
      const summary = summarizeDay(day);
      const hasWarning = summary.projectedCommittedWaterMl > day.settingsSnapshot.waterLimitMl;
      const healthCount = (careView.healthEvents || []).filter((item) => item.status === "ACTIVE" && localDateInTimezone(parseIso(item.occurred_at), day.timezone) === day.localDate).length;
      return `<button type="button" class="history-item" data-history-day="${day.id}">
        <div class="history-item-top"><strong>${formatDateJa(day.localDate, true)}</strong><small>${hasWarning ? "! 水分超過" : day.settingsSnapshot.dogName ? escapeHtml(day.settingsSnapshot.dogName) : "記録詳細"}</small></div>
        <div class="history-stats"><span>カロリー<b>${formatKcal(summary.actualCaloriesTenthKcal)} kcal</b></span><span>実績水分<b>${summary.actualWaterMl} ml</b></span><span>薬 / 排泄<b>${summary.completedMedicineDoses}回 / ${healthCount}件</b></span></div>
      </button>`;
    }).join("") : '<div class="empty-state">履歴はまだありません。</div>'}</div>`;
}

function renderHistoryDetail(day) {
  const summary = recalculatePlan(day, new Date(), "履歴表示");
  const isPast = day.id !== currentDay().id;
  historyView.innerHTML = `
    <div class="page-heading">
      <div><button class="back-button" type="button" data-action="history-back">← 履歴</button><h2 id="history-title">${formatDateJa(day.localDate, true)}</h2></div>
      <span class="date-chip">${escapeHtml(day.timezone)}</span>
    </div>
    ${isPast ? '<div class="past-banner">過去の記録を編集しています。今日の予定には影響しません。</div>' : ""}
    <div class="metric-grid">
      <div class="metric-card"><span class="metric-label">カロリー</span><strong class="metric-value">${formatKcal(summary.actualCaloriesTenthKcal)} kcal</strong><span class="metric-note">目標 ${formatKcal(day.settingsSnapshot.calorieTargetTenthKcal)}</span></div>
      <div class="metric-card"><span class="metric-label">実績水分</span><strong class="metric-value">${summary.actualWaterMl} ml</strong><span class="metric-note">上限 ${day.settingsSnapshot.waterLimitMl} ml</span></div>
      <div class="metric-card"><span class="metric-label">通常セット</span><strong class="metric-value">${summary.completedBalanceLiquidDoses} 回</strong></div>
      <div class="metric-card"><span class="metric-label">薬</span><strong class="metric-value">${summary.completedMedicineDoses} 回</strong></div>
    </div>
    ${careHistoryHtml(day)}
    <div class="section-heading"><h3>実績と予定</h3></div>
    ${timelineHtml(day, false)}
    <div class="section-heading"><h3>日次メモ</h3></div>
    <div class="note-box"><textarea id="history-day-note" maxlength="2000">${escapeHtml(day.note || "")}</textarea><div class="note-footer"><button class="button" type="button" data-action="save-history-note" data-day-id="${day.id}">メモを保存</button></div></div>
    <div class="section-heading"><h3>予定変更履歴</h3><span>${day.planRevisions.length}件</span></div>
    <div class="panel">${day.planRevisions.length ? `<ul class="revision-list">${[...day.planRevisions].reverse().map((revision) => `<li><strong>${displayTime(revision.occurredAt, day.timezone)} ${escapeHtml(revision.reason)}</strong><br>${revision.changes.map((change) => `${change.time}: ${STATUS_LABELS[change.from] || change.from}→${STATUS_LABELS[change.to] || change.to}`).join("、")}</li>`).join("")}</ul>` : '<p class="slot-meta">予定変更はありません。</p>'}</div>
    <div class="section-heading"><h3>当日の設定</h3></div>
    <div class="panel"><p class="slot-meta">カロリー目標 ${formatKcal(day.settingsSnapshot.calorieTargetTenthKcal)} kcal ／ 水分上限 ${day.settingsSnapshot.waterLimitMl} ml ／ タイムゾーン ${escapeHtml(day.timezone)}</p></div>`;
}

function renderSettings() {
  const s = state.settings;
  settingsView.innerHTML = `
    <div class="page-heading"><div><h2 id="settings-title">設定</h2><p>獣医師等の指示に合わせて変更してください</p></div></div>
    <form id="settings-form" class="settings-form">
      <section class="settings-section">
        <h3>基本設定</h3>
        <div class="field-grid">
          <div class="field full"><label for="dog-name">犬の名前</label><input id="dog-name" name="dogName" maxlength="60" value="${escapeHtml(s.dogName || "")}" placeholder="例：こむぎ"></div>
          <div class="field full"><label for="timezone">タイムゾーン</label><input id="timezone" name="timezone" value="${escapeHtml(s.timezone)}" required><span class="field-help">IANA形式。通常は Asia/Tokyo のまま使用します。</span></div>
          <div class="field"><label for="calorie-target">カロリー目標 (kcal)</label><input id="calorie-target" name="calorieTarget" type="number" min="0.1" max="5000" step="0.1" value="${formatKcal(s.calorieTargetTenthKcal)}" required></div>
          <div class="field"><label for="water-limit">水分上限 (ml)</label><input id="water-limit" name="waterLimit" type="number" min="1" max="10000" step="1" value="${s.waterLimitMl}" required></div>
        </div>
      </section>
      <section class="settings-section">
        <h3>通常セット</h3>
        <div class="field-grid">
          <div class="field"><label>1回のカロリー (kcal)</label><input name="balanceCalories" type="number" min="0.1" max="5000" step="0.1" value="${formatKcal(s.foods.balanceLiquid.caloriesTenthKcal)}" required></div>
          <div class="field"><label>バランスリキッド量 (ml)</label><input name="balanceAmount" type="number" min="1" max="10000" step="1" value="${s.foods.balanceLiquid.amountMl}" required></div>
          <div class="field"><label>セットに含む追加水 (ml)</label><input name="balanceAddedWater" type="number" min="0" max="10000" step="1" value="${s.foods.balanceLiquid.addedWaterMl || 0}" required><span class="field-help">通常セットの管理水分は両方の合計です。</span></div>
        </div>
      </section>
      <section class="settings-section">
        <h3>鶏ごはん・スープ缶</h3>
        <div class="field-grid">
          <div class="field"><label>鶏ごはん kcal</label><input name="chickenCalories" type="number" min="0" max="5000" step="0.1" value="${formatKcal(s.foods.chickenMeal.caloriesTenthKcal)}" required></div>
          <div class="field"><label>鶏ごはん水分 ml</label><input name="chickenWater" type="number" min="0" max="10000" step="1" value="${s.foods.chickenMeal.countedWaterMl}" required></div>
          <div class="field"><label>スープ缶 kcal</label><input name="soupCalories" type="number" min="0" max="5000" step="0.1" value="${formatKcal(s.foods.soupSyringe.caloriesTenthKcal)}" required></div>
          <div class="field"><label>スープ缶水分 ml</label><input name="soupWater" type="number" min="0" max="10000" step="1" value="${s.foods.soupSyringe.countedWaterMl}" required></div>
        </div>
      </section>
      <section class="settings-section">
        <h3>薬</h3>
        <div class="field-grid">
          <div class="field full"><label>薬の名称</label><input name="medicineName" maxlength="100" value="${escapeHtml(s.medicine.name)}" required></div>
          <div class="field"><label>1回量 (ml)</label><input name="medicineDose" type="number" min="0" max="10000" step="1" value="${s.medicine.doseMl}" required></div>
          <div class="field"><label>1日回数</label><input value="2回" readonly aria-readonly="true"></div>
          <div class="field full"><label>固定の予定時刻</label><input value="06:00・12:00" readonly aria-readonly="true"><span class="field-help">未投与の2回分は、常に水分枠へ予約します。</span></div>
        </div>
      </section>
      <section class="settings-section">
        <h3>スケジュール</h3>
        <div class="field-grid">
          <div class="field full"><label>通常セット予定（カンマ区切り）</label><input name="regularTimes" value="${escapeHtml(s.regularSlotTimes.join(", "))}" required></div>
          <div class="field"><label>調整枠</label><input name="adjustmentTime" type="time" value="${s.adjustmentSlotTime}" required></div>
        </div>
      </section>
      <div class="medical-note">このアプリは医療判断を代替しません。水分上限や栄養値、投薬回数は獣医師等の指示を確認してください。</div>
      <div class="button-row"><button type="submit" class="button" value="future">明日以降に適用</button><button type="submit" class="button primary" value="today">今日にも適用</button></div>
    </form>

    ${careSettingsHtml()}
    ${syncSettingsHtml()}
    <div class="section-heading"><h3>データ管理</h3></div>
    <section class="settings-section">
      <div class="data-actions">
        <button type="button" class="button" data-export="json">食事JSONバックアップ</button>
        <label class="file-label">食事JSONを取込<input id="import-json" type="file" accept="application/json,.json"></label>
        <button type="button" class="button" data-export="care-json" ${careView.ready ? "" : "disabled"}>介護JSON（閲覧用）</button>
        <button type="button" class="button" data-export="summary-csv">日次CSV</button>
        <button type="button" class="button" data-export="events-csv">明細CSV</button>
      </div>
      <p class="field-help">食事JSONはこの画面から取込み可能です。介護JSONは排泄・点眼の控えで、この画面からの復元には対応していません。</p>
      <div class="button-row"><button type="button" class="button ghost-danger" data-action="clear-data">${syncView.connected ? "この端末を家族データから再読込み" : "全データを消去"}</button></div>
    </section>`;
}

function parseTimes(value, allowEmpty = false) {
  const times = value.split(",").map((time) => time.trim()).filter(Boolean);
  if (!allowEmpty && !times.length) throw new Error("時刻を1件以上入力してください");
  if (times.some((time) => !new RegExp("^([01]\\d|2[0-3]):[0-5]\\d$").test(time))) throw new Error("時刻は HH:MM 形式で入力してください");
  return [...new Set(times)].sort();
}

function settingsFromForm(form) {
  const data = new FormData(form);
  const next = clone(state.settings);
  const tenth = (name) => Math.round(Number(data.get(name)) * 10);
  const integer = (name) => Number.parseInt(data.get(name), 10);
  next.dogName = String(data.get("dogName") || "").trim();
  next.timezone = String(data.get("timezone") || "").trim();
  try { new Intl.DateTimeFormat("ja-JP", { timeZone: next.timezone }).format(); } catch { throw new Error("タイムゾーンが正しくありません"); }
  next.calorieTargetTenthKcal = tenth("calorieTarget");
  next.waterLimitMl = integer("waterLimit");
  next.foods.balanceLiquid.caloriesTenthKcal = tenth("balanceCalories");
  next.foods.balanceLiquid.amountMl = integer("balanceAmount");
  next.foods.balanceLiquid.addedWaterMl = integer("balanceAddedWater");
  next.foods.balanceLiquid.countedWaterMl = next.foods.balanceLiquid.amountMl + next.foods.balanceLiquid.addedWaterMl;
  next.foods.chickenMeal.caloriesTenthKcal = tenth("chickenCalories");
  next.foods.chickenMeal.countedWaterMl = integer("chickenWater");
  next.foods.soupSyringe.caloriesTenthKcal = tenth("soupCalories");
  next.foods.soupSyringe.countedWaterMl = integer("soupWater");
  next.medicine.name = String(data.get("medicineName") || "").trim();
  next.medicine.doseMl = integer("medicineDose");
  next.medicine.dosesPerDay = 2;
  next.medicine.scheduledTimes = ["06:00", "12:00"];
  next.regularSlotTimes = parseTimes(String(data.get("regularTimes") || ""));
  next.adjustmentSlotTime = String(data.get("adjustmentTime"));
  const numericValues = [next.calorieTargetTenthKcal, next.waterLimitMl, next.foods.balanceLiquid.caloriesTenthKcal, next.foods.balanceLiquid.amountMl, next.foods.balanceLiquid.addedWaterMl, next.medicine.doseMl, next.medicine.dosesPerDay];
  if (numericValues.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("数値設定を確認してください");
  return next;
}

function rebuildDaySlots(day, settings) {
  const oldSlots = day.slots;
  const desired = [...settings.regularSlotTimes.map((time) => ({ time, role: "REGULAR" })), { time: settings.adjustmentSlotTime, role: "ADJUSTMENT" }];
  const keepStatuses = new Set(["COMPLETED", "SKIPPED", "FAILED"]);
  const stamp = new Date().toISOString();
  const rebuilt = desired.map(({ time, role }) => {
    const old = oldSlots.find((slot) => slot.scheduledTime === time && slot.role === role);
    return old || { id: uid("slot"), dayId: day.id, scheduledTime: time, role, status: role === "REGULAR" ? "PLANNED" : "ADJUSTMENT_AVAILABLE", plannedType: "BALANCE_LIQUID", revision: 1, updatedAt: stamp };
  });
  oldSlots.filter((slot) => keepStatuses.has(slot.status) && !rebuilt.some((item) => item.id === slot.id)).forEach((slot) => rebuilt.push(slot));
  day.slots = rebuilt.sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
}

async function recordBalanceLiquid(slotId = null) {
  const day = currentDay();
  const slot = slotId ? day.slots.find((item) => item.id === slotId) : null;
  if (slot && day.events.some((event) => event.status === "ACTIVE" && event.linkedSlotId === slot.id)) {
    showToast(`${slot.scheduledTime}枠はすでに記録されています`);
    return;
  }
  const before = summarizeDay(day);
  const afterWater = before.projectedCommittedWaterMl + day.settingsSnapshot.foods.balanceLiquid.countedWaterMl;
  if (afterWater > day.settingsSnapshot.waterLimitMl
      && !window.confirm(`この通常セットを記録すると、未投与の薬を含む見込み水分が${afterWater} mlとなり、上限を超えます。すでに与えた事実として記録しますか？`)) return;
  const event = createEvent(day, "BALANCE_LIQUID", new Date().toISOString(), { linkedSlotId: slot?.id, ...actorFields() });
  day.events.push(event);
  recalculatePlan(day, new Date(), reasonForType("BALANCE_LIQUID"), true);
  await commit();
  const label = slot ? `${slot.scheduledTime}枠の通常セット` : "通常セット";
  showToast(`${label}を記録しました`, async () => {
    event.status = "VOIDED";
    event.voidReason = "直前操作を取り消し";
    event.updatedAt = new Date().toISOString();
    recalculatePlan(day, new Date(), "取消し", true);
    await commit();
    showToast("記録を取り消しました");
  });
}

function openSimpleAmountDialog(type) {
  const water = type === "PLAIN_WATER";
  const label = EVENT_LABELS[type];
  const fieldLabel = water ? "飲水量 (ml)" : "カロリー (kcal)";
  dialogContent.innerHTML = `
    <h2 id="dialog-title">${label}を記録</h2>
    <p class="sheet-subtitle">現在時刻で記録し、予定へすぐ反映します。</p>
    <div class="field"><label for="simple-amount">${fieldLabel}</label><input id="simple-amount" name="amount" type="number" inputmode="decimal" min="${water ? "1" : "0.1"}" max="${water ? "10000" : "5000"}" step="${water ? "1" : "0.1"}" required autofocus></div>
    <div class="button-row"><button type="button" class="button" data-action="close-dialog">戻る</button><button type="submit" class="button primary">記録する</button></div>`;
  pendingDialogAction = async (form) => {
    const amount = Number(form.elements.amount.value);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${fieldLabel}を確認してください`);
    const options = water
      ? { caloriesTenthKcal: 0, countedWaterMl: Math.round(amount) }
      : { caloriesTenthKcal: Math.round(amount * 10), countedWaterMl: 0 };
    const day = currentDay();
    const event = createEvent(day, type, new Date().toISOString(), { ...options, ...actorFields() });
    day.events.push(event);
    recalculatePlan(day, new Date(), reasonForType(type), true);
    await commit();
    showToast(`${label}を記録しました`, async () => {
      event.status = "VOIDED";
      event.voidReason = "直前操作を取り消し";
      event.updatedAt = new Date().toISOString();
      recalculatePlan(day, new Date(), "取消し", true);
      await commit();
      showToast("記録を取り消しました");
    });
  };
  dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector("#simple-amount")?.focus());
}

function openRecordDialog(type, slotId = null, requestedMedicineTime = null) {
  const day = currentDay();
  const s = day.settingsSnapshot;
  const medicineTime = type === "VOMIT_BUSTER"
    ? requestedMedicineTime || medicineSchedule(day).doses.find((dose) => !dose.event)?.scheduledTime || null
    : null;
  const nutrition = eventNutrition(type, s);
  const summary = summarizeDay(day);
  const afterActualWater = summary.actualWaterMl + nutrition.countedWaterMl;
  const medicineCountAfter = summary.completedMedicineDoses + (type === "VOMIT_BUSTER" ? 1 : 0);
  const afterReserved = Math.max(0, s.medicine.dosesPerDay - medicineCountAfter) * s.medicine.doseMl;
  const afterProjectedWater = afterActualWater + afterReserved;
  const afterCalories = summary.actualCaloriesTenthKcal + nutrition.caloriesTenthKcal;
  const waterOver = afterProjectedWater > s.waterLimitMl;
  const medicineDuplicate = type === "VOMIT_BUSTER" && summary.completedMedicineDoses >= s.medicine.dosesPerDay;
  const sameRecent = day.events.some((event) => event.status === "ACTIVE" && event.type === type && Math.abs(Date.now() - parseIso(event.occurredAt).getTime()) < 60000);
  const slot = slotId ? day.slots.find((item) => item.id === slotId) : null;
  const plannedOutside = slot && !["PLANNED", "OVERDUE"].includes(slot.status);
  const label = type === "VOMIT_BUSTER" ? s.medicine.name : EVENT_LABELS[type];
  const warnings = [
    waterOver ? `<div class="dialog-warning">未投与の薬を含む見込み水分が ${afterProjectedWater} mlとなり、上限 ${s.waterLimitMl} mlを超えます。すでに与えた事実は記録できます。対応は獣医師の指示を確認してください。</div>` : "",
    medicineDuplicate ? `<div class="dialog-caution">本日の薬はすでに ${summary.completedMedicineDoses} 回記録されています。重複でないことを確認してください。</div>` : "",
    sameRecent ? '<div class="dialog-caution">同じ種類の記録が1分以内にあります。二重入力でないことを確認してください。</div>' : "",
    plannedOutside ? '<div class="dialog-caution">この枠は現在の推奨予定に含まれていません。実際に与えた場合のみ記録してください。</div>' : ""
  ].join("");

  dialogContent.innerHTML = `
    <h2 id="dialog-title">${escapeHtml(label)}を記録</h2>
    <p class="sheet-subtitle">${slot ? `${slot.scheduledTime} の枠に紐づけます` : medicineTime ? `${medicineTime} の薬予定に紐づけます` : "実績だけが集計に加算されます"}</p>
    <div class="confirm-summary">
      <div><span>今回のカロリー</span><strong>${formatKcal(nutrition.caloriesTenthKcal)} kcal</strong></div>
      <div><span>今回の管理水分</span><strong>${nutrition.countedWaterMl} ml</strong></div>
      <div><span>記録後の実績</span><strong>${formatKcal(afterCalories)} kcal</strong></div>
      <div><span>薬を含む見込み</span><strong>${afterProjectedWater} ml</strong></div>
    </div>
    ${warnings}
    <div class="field-grid">
      <div class="field full"><label for="record-time">記録時刻</label><input id="record-time" name="occurredAt" type="datetime-local" value="${datetimeLocalValue()}" required></div>
      <div class="field full"><label for="record-note">メモ（任意）</label><textarea id="record-note" name="note" maxlength="500" rows="2"></textarea></div>
    </div>
    <div class="button-row"><button type="button" class="button" data-action="close-dialog">戻る</button><button type="submit" class="button ${waterOver ? "danger" : "primary"}">${waterOver ? "すでに与えたので実績として記録" : "実績として記録"}</button></div>`;
  pendingDialogAction = async (form) => {
    const occurredInput = form.elements.occurredAt.value;
    const occurredAt = new Date(occurredInput).toISOString();
    const event = createEvent(day, type, occurredAt, { linkedSlotId: slotId, note: form.elements.note.value, ...actorFields() });
    if (medicineTime) event.medicineScheduledTime = medicineTime;
    day.events.push(event);
    recalculatePlan(day, new Date(), reasonForType(type), true);
    await commit();
    showToast(`${label}を記録しました`, async () => {
      event.status = "VOIDED";
      event.voidReason = "直前操作を取り消し";
      event.updatedAt = new Date().toISOString();
      recalculatePlan(day, new Date(), "取消し", true);
      await commit();
      showToast("記録を取り消しました");
    });
  };
  dialog.showModal();
}

function openSlotStateDialog(slotId, status) {
  const day = currentDay();
  const slot = day.slots.find((item) => item.id === slotId);
  if (!slot) return;
  const label = status === "SKIPPED" ? "スキップ" : "失敗／飲ませられなかった";
  dialogContent.innerHTML = `
    <h2 id="dialog-title">${slot.scheduledTime}を${label}</h2>
    <p class="sheet-subtitle">摂取量には加算せず、未来の予定を再計算します。</p>
    <div class="field"><label for="slot-reason">理由・メモ（任意）</label><textarea id="slot-reason" name="reason" maxlength="500" rows="3"></textarea></div>
    <div class="button-row"><button type="button" class="button" data-action="close-dialog">戻る</button><button type="submit" class="button primary">${label}として保存</button></div>`;
  pendingDialogAction = async (form) => {
    const previous = { status: slot.status, changeReason: slot.changeReason };
    slot.status = status;
    slot.changeReason = form.elements.reason.value.trim() || label;
    slot.revision += 1;
    slot.updatedAt = new Date().toISOString();
    recalculatePlan(day, new Date(), label, true);
    await commit();
    showToast(`${slot.scheduledTime}を${label}にしました`, async () => {
      slot.status = previous.status;
      slot.changeReason = previous.changeReason;
      recalculatePlan(day, new Date(), "直前操作を取り消し", true);
      await commit();
      showToast("状態を元に戻しました");
    });
  };
  dialog.showModal();
}

function openEditEventDialog(dayId, eventId) {
  const day = state.days.find((item) => item.id === dayId);
  const event = day?.events.find((item) => item.id === eventId);
  if (!day || !event) return;
  const voided = event.status === "VOIDED";
  const simpleWater = event.type === "PLAIN_WATER";
  const simpleSolid = event.type === "SOLID_FOOD";
  const simple = simpleWater || simpleSolid;
  const editFields = simpleWater
    ? `<div class="field full"><label>飲水量 (ml)</label><input name="water" type="number" min="1" max="10000" step="1" value="${event.countedWaterMl}" required></div>`
    : simpleSolid
      ? `<div class="field full"><label>カロリー (kcal)</label><input name="calories" type="number" min="0.1" max="5000" step="0.1" value="${formatKcal(event.caloriesTenthKcal)}" required></div>`
      : `<div class="field full"><label>記録時刻</label><input name="occurredAt" type="datetime-local" value="${datetimeLocalValue(event.occurredAt)}" required></div>
      <div class="field"><label>カロリー (kcal)</label><input name="calories" type="number" min="0" max="5000" step="0.1" value="${formatKcal(event.caloriesTenthKcal)}" required></div>
      <div class="field"><label>管理水分 (ml)</label><input name="water" type="number" min="0" max="10000" step="1" value="${event.countedWaterMl}" required></div>
      <div class="field full"><label>メモ</label><textarea name="note" maxlength="500" rows="3">${escapeHtml(event.note || "")}</textarea></div>`;
  dialogContent.innerHTML = `
    <h2 id="dialog-title">${escapeHtml(EVENT_LABELS[event.type] || event.type)}の実績</h2>
    <p class="sheet-subtitle">${simple ? `${displayTime(event.occurredAt, day.timezone)}に記録しました。` : event.medicineScheduledTime ? `${event.medicineScheduledTime}の薬予定に紐づいています。` : ""}変更後は予定を再計算します。</p>
    ${voided ? `<div class="dialog-caution">この実績は取消し済みです。理由：${escapeHtml(event.voidReason || "未入力")}</div>` : ""}
    <div class="field-grid">
      ${editFields}
    </div>
    <div class="button-row">
      ${voided ? '<button type="button" class="button" data-action="restore-event">取消しを解除</button>' : '<button type="button" class="button ghost-danger" data-action="void-event">実績を取消す</button>'}
      <button type="button" class="button" data-action="close-dialog">閉じる</button>
      ${voided ? "" : '<button type="submit" class="button primary">変更を保存</button>'}
    </div>`;
  pendingDialogAction = async (form) => {
    if (simpleWater) event.countedWaterMl = Number.parseInt(form.elements.water.value, 10);
    else if (simpleSolid) event.caloriesTenthKcal = Math.round(Number(form.elements.calories.value) * 10);
    else {
      event.occurredAt = new Date(form.elements.occurredAt.value).toISOString();
      event.caloriesTenthKcal = Math.round(Number(form.elements.calories.value) * 10);
      event.countedWaterMl = Number.parseInt(form.elements.water.value, 10);
      event.note = form.elements.note.value.trim();
    }
    event.updatedAt = new Date().toISOString();
    recalculatePlan(day, new Date(), "実績編集", true);
    await commit();
    showToast("実績を更新しました");
  };
  dialog.dataset.dayId = day.id;
  dialog.dataset.eventId = event.id;
  dialog.showModal();
}

async function changeEventVoidState(restore) {
  const day = state.days.find((item) => item.id === dialog.dataset.dayId);
  const event = day?.events.find((item) => item.id === dialog.dataset.eventId);
  if (!event) return;
  event.status = restore ? "ACTIVE" : "VOIDED";
  event.voidReason = restore ? undefined : "利用者による取消し";
  event.updatedAt = new Date().toISOString();
  recalculatePlan(day, new Date(), restore ? "実績復元" : "実績取消し", true);
  dialog.close();
  await commit();
  showToast(restore ? "実績を復元しました" : "実績を取り消しました");
}

function closeDialog() {
  if (dialog.open) dialog.close();
  pendingDialogAction = null;
  delete dialog.dataset.dayId;
  delete dialog.dataset.eventId;
}

actionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pendingDialogAction || !actionForm.reportValidity()) return;
  withMutationLock(async () => {
    const action = pendingDialogAction;
    closeDialog();
    await action(actionForm);
  });
});

async function runCareMutation(action, successMessage) {
  try {
    await action();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(error.message || "介護データを更新できませんでした");
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-route]");
  if (!target) return;
  if (target.dataset.route) {
    route = target.dataset.route;
    selectedHistoryDayId = null;
    renderApp();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (target.dataset.health) {
    const type = target.dataset.health;
    withMutationLock(() => runCareMutation(async () => {
      const id = await careFeatures.recordHealth(type);
      showToast(`${type === "urine" ? "小" : "大"}を${displayTime(new Date().toISOString(), state.settings.timezone)}に記録しました`,
        () => runCareMutation(() => careFeatures.voidHealth(id), "排泄記録を取り消しました"));
    }));
    return;
  }
  if (target.dataset.eyeClaim) {
    withMutationLock(() => runCareMutation(async () => {
      if (!careView.notificationPreferences?.master_enabled
          && !window.confirm("通知がOFFです。画面上のタイマーは使えますが、バックグラウンド通知は届きません。この回を担当しますか？")) return;
      await careFeatures.claimSession(target.dataset.eyeClaim);
    }, "点眼の担当になりました"));
    return;
  }
  if (target.dataset.eyeComplete) {
    withMutationLock(() => runCareMutation(() => careFeatures.completeStep(target.dataset.eyeComplete), "点眼を記録しました"));
    return;
  }
  if (target.dataset.eyeTakeover) {
    if (!window.confirm("現在の担当者からこの点眼セッションを引き継ぎますか？")) return;
    withMutationLock(() => runCareMutation(() => careFeatures.takeoverSession(target.dataset.eyeTakeover), "点眼担当を引き継ぎました"));
    return;
  }
  if (target.dataset.record) {
    if (["PLAIN_WATER", "SOLID_FOOD"].includes(target.dataset.record)) openSimpleAmountDialog(target.dataset.record);
    else openRecordDialog(target.dataset.record, null, target.dataset.medicineTime || null);
    return;
  }
  if (target.dataset.slotAction) {
    const day = currentDay();
    const slot = day.slots.find((item) => item.id === target.dataset.slotId);
    if (!slot) return;
    if (target.dataset.slotAction === "give") withMutationLock(() => recordBalanceLiquid(slot.id));
    if (target.dataset.slotAction === "skip") openSlotStateDialog(slot.id, "SKIPPED");
    if (target.dataset.slotAction === "fail") openSlotStateDialog(slot.id, "FAILED");
    if (target.dataset.slotAction === "reset") withMutationLock(async () => {
      slot.status = "PLANNED";
      slot.changeReason = "状態を戻した";
      recalculatePlan(day, new Date(), "状態を戻した", true);
      await commit();
      showToast("枠の状態を戻しました");
    });
    return;
  }
  if (target.dataset.editEvent) {
    openEditEventDialog(target.dataset.dayId, target.dataset.editEvent);
    return;
  }
  if (target.dataset.historyDay) {
    selectedHistoryDayId = target.dataset.historyDay;
    renderHistory();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (target.dataset.export) {
    exportData(target.dataset.export).catch((error) => showToast(error.message || "データを出力できませんでした"));
    return;
  }
  switch (target.dataset.action) {
    case "close-dialog": closeDialog(); break;
    case "void-event": withMutationLock(() => changeEventVoidState(false)); break;
    case "restore-event": withMutationLock(() => changeEventVoidState(true)); break;
    case "history-back": selectedHistoryDayId = null; renderHistory(); break;
    case "save-note": saveNote(target.dataset.dayId, "#day-note"); break;
    case "save-history-note": saveNote(target.dataset.dayId, "#history-day-note"); break;
    case "undo": if (undoAction) { const action = undoAction; undoAction = null; toast.hidden = true; withMutationLock(action); } break;
    case "clear-data": clearAllData(); break;
    case "record-balance": withMutationLock(() => recordBalanceLiquid(target.dataset.slotId || null)); break;
    case "start-family-sync": startFamilySync(); break;
    case "copy-invite": copyInviteUrl(); break;
    case "sync-now": familySync?.flush().then(() => familySync.pull()); break;
    case "clear-sync-conflicts": familySync?.clearConflicts(); break;
    case "install-app": installApp(); break;
    case "dismiss-install":
      try { localStorage.setItem("dogcare-install-help-dismissed", "1"); } catch { /* no-op */ }
      renderToday();
      break;
    case "enable-push": withMutationLock(() => runCareMutation(() => careFeatures.enablePush(), "この端末の通知を有効にしました")); break;
  }
});

async function installApp() {
  if (!installPromptEvent) return;
  installPromptEvent.prompt();
  await installPromptEvent.userChoice;
  installPromptEvent = null;
  try { localStorage.setItem("dogcare-install-help-dismissed", "1"); } catch { /* no-op */ }
  renderToday();
}

document.addEventListener("submit", (event) => {
  if (event.target.id === "join-family-form") {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    withMutationLock(async () => {
      try {
        pendingDisplayName = event.target.elements.displayName.value.trim();
        await familySync.joinFamily(event.target.elements.invite.value);
        await careFeatures.initialize(pendingDisplayName);
        pendingDisplayName = "";
        showToast("家族データに参加しました。次回から自動で同期します。");
      } catch (error) {
        showToast(error.message || "招待URLを確認できませんでした");
      }
    });
    return;
  }
  if (event.target.id === "care-profile-form") {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    withMutationLock(() => runCareMutation(async () => {
      await careFeatures.saveDisplayName(event.target.elements.displayName.value);
      await careFeatures.saveNotificationPreferences({
        master_enabled: event.target.elements.master.checked,
        scheduled_eye_drop_enabled: event.target.elements.scheduled.checked,
        active_eye_drop_timer_enabled: event.target.elements.timer.checked
      });
    }, "個人設定を保存しました"));
    return;
  }
  if (event.target.id === "eye-settings-form") {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    withMutationLock(() => runCareMutation(async () => {
      const dropTypes = event.target.elements.dropTypes.value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [id, name, required] = line.split("|").map((part) => part.trim());
        if (!id || !name || !new RegExp("^\\d+$").test(required || "")) throw new Error("点眼薬は ID|表示名|1日必要回数 の形式で入力してください");
        return { id, name, requiredDailyCount: Number(required) };
      });
      const idByName = new Map(dropTypes.map((item) => [item.name, item.id]));
      const enteredTemplates = event.target.elements.templates.value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const separator = line.indexOf("=");
        if (separator < 0) throw new Error("時刻別スケジュールは HH:MM=点眼名,点眼名 の形式で入力してください");
        const time = line.slice(0, separator).trim();
        if (!EYE_DROP_TIMES.includes(time)) throw new Error(`${time}は使用できない点眼時刻です`);
        const names = line.slice(separator + 1).split(",").map((name) => name.trim()).filter(Boolean);
        return { time, steps: names.map((name) => {
          const id = idByName.get(name);
          if (!id) throw new Error(`${time}の「${name}」は点眼薬一覧にありません`);
          return id;
        }) };
      });
      const byTime = new Map(enteredTemplates.map((item) => [item.time, item]));
      const templates = EYE_DROP_TIMES.map((time) => byTime.get(time) || { time, steps: [] });
      const validation = validateEyeDropSettings(dropTypes, templates);
      if (validation.countWarnings.length && !window.confirm(`${validation.countWarnings.join("\n")}\n\n必要回数と予定回数が一致していません。このまま翌日以降へ保存しますか？`)) return;
      await careFeatures.saveEyeDropSettings(dropTypes, templates, Number(event.target.elements.intervalMinutes.value) * 60);
    }, "翌日以降の点眼設定を保存しました"));
    return;
  }
  if (event.target.id !== "settings-form") return;
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  withMutationLock(async () => {
    try {
      const next = settingsFromForm(event.target);
      const applyToday = event.submitter?.value === "today";
      const previousToday = currentDay();
      state.settings = next;
      if (applyToday) {
        const targetDate = localDateInTimezone(new Date(), next.timezone);
        let day = state.days.find((item) => item.localDate === targetDate);
        if (!day && previousToday?.localDate === targetDate) day = previousToday;
        if (!day) {
          day = createDay(targetDate, next);
          state.days.push(day);
        }
        day.timezone = next.timezone;
        day.settingsSnapshot = clone(next);
        rebuildDaySlots(day, next);
        recalculatePlan(day, new Date(), "日次設定変更", true);
      }
      await commit();
      showToast(applyToday ? "設定を今日と明日以降に適用しました" : "設定を明日以降に適用しました");
    } catch (error) {
      showToast(error.message || "設定を保存できませんでした");
    }
  });
});

document.addEventListener("change", (event) => {
  if (event.target.id === "import-json" && event.target.files?.[0]) importJson(event.target.files[0]);
});

async function saveNote(dayId, selector) {
  const day = state.days.find((item) => item.id === dayId);
  const input = document.querySelector(selector);
  if (!day || !input) return;
  day.note = input.value.trim();
  day.updatedAt = new Date().toISOString();
  await commit({ render: false });
  showToast("メモを保存しました");
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const string = String(value ?? "");
  return `"${string.replaceAll('"', '""')}"`;
}

async function exportData(kind) {
  const stamp = localDateInTimezone(new Date(), state.settings.timezone);
  if (kind === "json") {
    download(`inu-care-backup-${stamp}.json`, JSON.stringify(state, null, 2), "application/json;charset=utf-8");
    showToast("JSONバックアップを出力しました");
    return;
  }
  if (kind === "care-json") {
    if (!careView.ready) {
      showToast("介護データの同期後に出力してください");
      return;
    }
    const careBackup = await careFeatures.exportCareData();
    download(`inu-care-care-data-${stamp}.json`, JSON.stringify(careBackup, null, 2), "application/json;charset=utf-8");
    showToast("介護データの閲覧用JSONを出力しました");
    return;
  }
  let rows;
  if (kind === "summary-csv") {
    rows = [["日付", "犬の名前", "カロリー(kcal)", "実績水分(ml)", "薬回数", "鶏ごはん回数", "通常セット回数", "メモ"]];
    [...state.days].sort((a, b) => a.localDate.localeCompare(b.localDate)).forEach((day) => {
      const s = summarizeDay(day);
      rows.push([day.localDate, day.settingsSnapshot.dogName || "", formatKcal(s.actualCaloriesTenthKcal), s.actualWaterMl, s.completedMedicineDoses, s.chickenMealCount, s.completedBalanceLiquidDoses, day.note || ""]);
    });
  } else {
    rows = [["日付", "実績ID", "種別", "記録時刻", "記録者", "カロリー(kcal)", "管理水分(ml)", "状態", "メモ", "取消し理由"]];
    [...state.days].sort((a, b) => a.localDate.localeCompare(b.localDate)).forEach((day) => day.events.forEach((item) => {
      rows.push([day.localDate, item.id, EVENT_LABELS[item.type] || item.type, item.occurredAt, item.recordedByName || "", formatKcal(item.caloriesTenthKcal), item.countedWaterMl, item.status, item.note || "", item.voidReason || ""]);
    }));
  }
  const csv = `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  download(`inu-care-${kind}-${stamp}.csv`, csv, "text/csv;charset=utf-8");
  showToast("CSVを出力しました");
}

function validateImportedState(candidate) {
  if (!candidate || ![1, 2, 3, SCHEMA_VERSION].includes(candidate.schemaVersion) || !candidate.settings || !Array.isArray(candidate.days)) throw new Error("対応していないバックアップ形式です");
  for (const day of candidate.days) {
    if (!day.id || !day.localDate || !day.settingsSnapshot || !Array.isArray(day.events) || !Array.isArray(day.slots)) throw new Error("日別データの形式が正しくありません");
  }
  return migrateState(candidate);
}

async function importJson(file) {
  try {
    const candidate = validateImportedState(JSON.parse(await file.text()));
    const replace = window.confirm("現在のデータをバックアップの内容で置き換えます。続けますか？");
    if (!replace) return;
    state = candidate;
    ensureToday();
    selectedHistoryDayId = null;
    await commit();
    showToast("バックアップを取り込みました");
  } catch (error) {
    showToast(error.message || "バックアップを読み込めませんでした");
  }
}

async function clearAllData() {
  if (familySync?.isConnected()) {
    const reload = window.confirm("この端末の内容を破棄し、家族データの最新版を再読込みします。Supabase上の家族データは削除されません。続けますか？");
    if (!reload) return;
    try {
      await familySync.reloadFromCloud();
      selectedHistoryDayId = null;
      showToast("家族データから再読込みしました");
    } catch (error) {
      showToast(error.message || "再読込みできませんでした");
    }
    return;
  }
  const answer = window.prompt("全記録を消去します。確認のため「全削除」と入力してください。");
  if (answer !== "全削除") {
    if (answer !== null) showToast("入力が一致しないため消去しませんでした");
    return;
  }
  try {
    await clearState();
    state = createInitialState();
    ensureToday();
    selectedHistoryDayId = null;
    await commit();
    showToast("すべてのデータを消去しました。元に戻せません。");
  } catch (error) {
    showToast("データを消去できませんでした");
  }
}

async function startFamilySync() {
  const confirmed = window.confirm("この端末の現在の記録を、家族で共有する最初のデータとして登録します。続けますか？");
  if (!confirmed) return;
  const displayName = window.prompt("家族に表示するあなたの名前を入力してください", careView.profile?.display_name || "自分");
  if (!displayName?.trim()) {
    showToast("表示名が未入力のため開始しませんでした");
    return;
  }
  try {
    pendingDisplayName = displayName.trim();
    const inviteUrl = await familySync.startFamily();
    await careFeatures.initialize(pendingDisplayName);
    pendingDisplayName = "";
    renderSettings();
    showToast("家族同期を開始しました。次に招待URLを家族へ送ってください。");
    if (inviteUrl && navigator.clipboard?.writeText) await navigator.clipboard.writeText(inviteUrl).catch(() => {});
  } catch (error) {
    showToast(error.message || "家族同期を開始できませんでした");
  }
}

async function copyInviteUrl() {
  const inviteUrl = familySync?.getSnapshot().inviteUrl;
  if (!inviteUrl) return;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    showToast("招待URLをコピーしました");
  } catch {
    window.prompt("この招待URLをコピーしてください", inviteUrl);
  }
}

function migrateState(loaded) {
  return migrateStateToCurrent(loaded);
}

function normalizeLoadedState(loaded) {
  if (!loaded || ![1, 2, 3, SCHEMA_VERSION].includes(loaded.schemaVersion) || !loaded.settings || !Array.isArray(loaded.days)) return createInitialState();
  migrateState(loaded);
  loaded.days.forEach((day) => {
    day.events ||= [];
    day.slots ||= [];
    day.planRevisions ||= [];
    day.note ||= "";
  });
  return loaded;
}

function ensureToday() {
  const date = localDateInTimezone(new Date(), state.settings.timezone);
  let day = state.days.find((item) => item.localDate === date);
  if (!day) {
    day = createDay(date, state.settings);
    state.days.push(day);
  }
  recalculatePlan(day, new Date(), "アプリ起動");
  return day;
}

async function init() {
  try {
    const loaded = await Promise.race([
      loadState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("端末保存の初期化がタイムアウトしました")), 1800))
    ]);
    state = normalizeLoadedState(loaded);
  } catch (error) {
    state = createInitialState();
    volatileMode = true;
    setSaveStatus("一時セッション", true);
    showToast("端末保存を利用できません。この画面を閉じると記録が失われます。");
    console.error(error);
  }
  ensureToday();
  careFeatures = createCareFeatures({
    timezone: () => state.settings.timezone,
    localDate: () => localDateInTimezone(new Date(), state.settings.timezone),
    onChange: (nextCareView) => {
      careView = nextCareView;
      if (state) renderApp();
    },
    onMessage: (message) => showToast(message)
  });
  familySync = createFamilySync({
    getState: () => state,
    applyState: async (nextState) => {
      state = normalizeLoadedState(nextState);
      ensureToday();
      await saveState(state);
      selectedHistoryDayId = null;
      renderApp();
    },
    onStatus: (nextStatus) => {
      syncView = nextStatus;
      setSaveStatus(nextStatus.message, nextStatus.error);
      if (nextStatus.connected) careFeatures.initialize(pendingDisplayName);
      if (state && route === "settings") renderSettings();
      if (state && route === "today") renderToday();
    },
    onConflict: (message) => showToast(message)
  });
  renderApp();
  await persist();
  familySync.initialize();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service Worker registration failed", error));
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && route === "today") {
      ensureToday();
      renderToday();
      persist();
      familySync.pull();
      if (careView.ready) careFeatures.reload().catch(() => {});
    }
  });
  setInterval(() => {
    if (!document.hidden && careView.ready && currentEyeSessions().some((session) => session.status === "in_progress")) {
      if (route === "today") renderToday();
      if (route === "eyedrops") renderEyeDrops();
    }
  }, 1000);
}

init();
