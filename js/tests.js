import { medicineSchedule, setSlotManualState, solidFoodNutrition, soupNutrition, clone, createDay, createEvent, migrateStateToCurrent, recalculatePlan, selectEvenly, summarizeDay } from "./domain.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { mergeFamilyStates } from "./sync.js";
import { getSupabaseClient } from "./supabase-client.js";
import { inviteTokenFromInput } from "./auth.js";
import { formatCountdown, secondsUntil, validateEyeDropSettings } from "./care.js";

const resultNode = document.querySelector("#test-results");
const summaryNode = document.querySelector("#test-summary");
const results = [];
const morning = new Date("2026-08-27T21:00:00.000Z"); // 06:00 JST
const at11 = new Date("2026-08-28T02:00:00.000Z");
const at14 = new Date("2026-08-28T05:00:00.000Z");

function day(settings = clone(DEFAULT_SETTINGS), now = morning) {
  return createDay("2026-08-28", settings, now);
}

function add(target, type, count = 1, linkedSlots = []) {
  for (let index = 0; index < count; index += 1) {
    target.events.push(createEvent(target, type, "2026-08-27T22:00:00.000Z", { linkedSlotId: linkedSlots[index]?.id }));
  }
}

function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass, actual, expected });
}

{
  const d = day();
  const s = recalculatePlan(d, morning);
  check("TC-F01 新規日は8回、192 kcal、薬込み194 ml", [s.recommendedRemainingDoses, s.predictedCaloriesTenthKcal, s.predictedWaterMl], [8, 1920, 194]);
  check("TC-F01 水分優先で22時は追加しない", d.slots.find((slot) => slot.role === "ADJUSTMENT").status, "ADJUSTMENT_AVAILABLE");
}

[
  [1, 7, 2079, 171], [2, 5, 1998, 125], [3, 4, 2157, 102], [4, 2, 2076, 56], [5, 0, 1995, 10]
].forEach(([chicken, sets, calories, water]) => {
  const d = day();
  add(d, "CHICKEN_MEAL", chicken);
  const s = recalculatePlan(d, morning);
  check(`T04-T08 鶏ごはん${chicken}食`, [s.recommendedRemainingDoses, s.predictedCaloriesTenthKcal, s.predictedWaterMl], [sets, calories, water]);
});

{
  const d = day();
  const completed = d.slots.slice(0, 3);
  add(d, "BALANCE_LIQUID", 3, completed);
  add(d, "CHICKEN_MEAL");
  const s1 = recalculatePlan(d, at11);
  check("T09 バランスリキッド3回後に鶏1食で未来4回", [s1.completedBalanceLiquidDoses, s1.recommendedRemainingDoses], [3, 4]);
  add(d, "CHICKEN_MEAL");
  const s2 = recalculatePlan(d, at11);
  check("T10 さらに鶏1食で未来2回", [s2.completedBalanceLiquidDoses, s2.recommendedRemainingDoses], [3, 2]);
}

{
  const d = day();
  add(d, "CHICKEN_MEAL", 4);
  recalculatePlan(d, at14);
  const planned = d.slots.filter((slot) => slot.status === "PLANNED").map((slot) => slot.scheduledTime);
  check("T11 14/16/18/20から2回を均等配置", planned, ["16:00", "20:00"]);
  check("均等配置の単体確認", selectEvenly([14, 16, 18, 20], 2), [16, 20]);
}

{
  const d = day();
  add(d, "VOMIT_BUSTER");
  const s = summarizeDay(d);
  check("T15 薬1回で実績+5、予約-5、見込み不変", [s.actualWaterMl, s.reservedMedicineWaterMl, s.projectedCommittedWaterMl], [5, 5, 10]);
}

{
  const d = day();
  const noonDose = createEvent(d, "VOMIT_BUSTER", "2026-08-28T03:05:00.000Z");
  noonDose.medicineScheduledTime = "12:00";
  d.events.push(noonDose);
  const at13 = new Date("2026-08-28T04:00:00.000Z");
  const s = recalculatePlan(d, at13);
  const medicineWarning = s.warnings.find((warning) => warning.title.includes("薬が"));
  check("薬予定は06:00と12:00に固定", d.settingsSnapshot.medicine.scheduledTimes, ["06:00", "12:00"]);
  check("12時分を記録済みなら未記録警告は06時分だけ", medicineWarning?.message.includes("06:00") && !medicineWarning?.message.includes("12:00"), true);
}

{
  const settings = clone(DEFAULT_SETTINGS);
  settings.waterLimitMl = 32; // 予約10 + 残り22
  const d = day(settings);
  check("境界値 残り22 mlでは0回", recalculatePlan(d, morning).recommendedRemainingDoses, 0);
  d.settingsSnapshot.waterLimitMl = 33; // 予約10 + 残り23
  check("境界値 残り23 mlでは1回", recalculatePlan(d, morning).recommendedRemainingDoses, 1);
}

{
  const remote = { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [day()], updatedAt: "2026-08-29T00:00:00.000Z" };
  const local = clone(remote);
  const remoteDay = remote.days[0];
  const localDay = local.days[0];
  remoteDay.events.push(createEvent(remoteDay, "CHICKEN_MEAL", "2026-08-28T00:00:00.000Z"));
  localDay.events.push(createEvent(localDay, "SOUP_SYRINGE", "2026-08-28T01:00:00.000Z"));
  const merged = mergeFamilyStates(remote, local);
  check("同期: 別端末の異なる実績を両方残す", merged.state.days[0].events.map((event) => event.type).sort(), ["CHICKEN_MEAL", "SOUP_SYRINGE"]);
}

{
  const remoteDay = day();
  const localDay = clone(remoteDay);
  localDay.id = "day_local";
  localDay.slots.forEach((slot) => { slot.id = `local_${slot.id}`; slot.dayId = localDay.id; });
  const remoteDose = createEvent(remoteDay, "VOMIT_BUSTER", "2026-08-28T00:00:00.000Z");
  remoteDose.medicineScheduledTime = "06:00";
  const localDose = createEvent(localDay, "VOMIT_BUSTER", "2026-08-28T00:01:00.000Z");
  localDose.medicineScheduledTime = "06:00";
  remoteDay.events.push(remoteDose);
  localDay.events.push(localDose);
  const remote = { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [remoteDay], updatedAt: "2026-08-29T00:00:00.000Z" };
  const local = { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [localDay], updatedAt: "2026-08-29T00:01:00.000Z" };
  const merged = mergeFamilyStates(remote, local);
  const doses = merged.state.days[0].events.filter((event) => event.type === "VOMIT_BUSTER");
  check("同期: 同じ06:00薬は有効1件だけ", doses.filter((event) => event.status === "ACTIVE").length, 1);
  check("同期: 二重薬を消さず取消し履歴として残す", doses.filter((event) => event.status === "VOIDED").length, 1);
  check("同期: 二重薬の競合警告を返す", merged.conflicts.some((message) => message.includes("06:00の薬")), true);
}

{
  const remoteDay = day();
  const localDay = clone(remoteDay);
  localDay.id = "day_local";
  const remoteFirst = remoteDay.slots[0];
  localDay.slots.forEach((slot) => { slot.id = `local_${slot.id}`; slot.dayId = localDay.id; });
  const localEvent = createEvent(localDay, "BALANCE_LIQUID", "2026-08-28T00:00:00.000Z", { linkedSlotId: localDay.slots[0].id });
  localDay.events.push(localEvent);
  const merged = mergeFamilyStates(
    { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [remoteDay], updatedAt: "2026-08-29T00:00:00.000Z" },
    { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [localDay], updatedAt: "2026-08-29T00:01:00.000Z" }
  );
  check("同期: 別端末の枠IDをサーバー側IDへ付け替える", merged.state.days[0].events[0].linkedSlotId, remoteFirst.id);
}

try {
  const client = await getSupabaseClient();
  check("同期: 同梱Supabaseクライアントを初期化できる", Boolean(client?.auth?.signInAnonymously && client?.rpc && client?.channel), true);
} catch (error) {
  check("同期: 同梱Supabaseクライアントを初期化できる", error.message, true);
}

{
  const base = { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [], updatedAt: "2026-08-29T00:00:00.000Z" };
  const remote = clone(base);
  const local = clone(base);
  remote.settings.dogName = "リモート";
  remote.updatedAt = "2026-08-29T00:01:00.000Z";
  local.settings.dogName = "ローカル";
  local.updatedAt = "2026-08-29T00:02:00.000Z";
  const merged = mergeFamilyStates(remote, local, base);
  check("同期: 同時に設定編集した場合は警告して新しい更新を採用", [merged.state.settings.dogName, merged.conflicts.some((message) => message.includes("設定"))], ["ローカル", true]);
}

{
  const d = day();
  d.events.push(createEvent(d, "PLAIN_WATER", morning.toISOString(), { countedWaterMl: 50 }));
  const s = recalculatePlan(d, morning);
  check("普通の水50 mlは水分だけに加算", [s.actualCaloriesTenthKcal, s.actualWaterMl, s.recommendedRemainingDoses], [0, 50, 6]);
}

{
  const d = day();
  d.events.push(createEvent(d, "SOLID_FOOD", morning.toISOString(), { caloriesTenthKcal: 1000 }));
  const s = recalculatePlan(d, morning);
  check("固形食100 kcalはカロリーだけに加算", [s.actualCaloriesTenthKcal, s.actualWaterMl, s.recommendedRemainingDoses], [1000, 0, 5]);
}

{
  const legacySettings = clone(DEFAULT_SETTINGS);
  legacySettings.schemaVersion = 2;
  legacySettings.foods.normalSet = { name: "通常セット", balanceLiquidMl: 18, addedWaterMl: 5, caloriesTenthKcal: 240, countedWaterMl: 23, indivisible: true };
  delete legacySettings.foods.balanceLiquid;
  const legacyDay = day();
  legacyDay.settingsSnapshot = clone(legacySettings);
  const legacyEvent = createEvent(day(), "BALANCE_LIQUID", morning.toISOString());
  legacyEvent.type = "NORMAL_SET";
  legacyEvent.countedWaterMl = 23;
  legacyDay.events.push(legacyEvent);
  const migrated = migrateStateToCurrent({ schemaVersion: 2, settings: legacySettings, days: [legacyDay], updatedAt: morning.toISOString() });
  check("移行: 旧通常セットの実績23 mlを保持", [migrated.settings.foods.balanceLiquid.countedWaterMl, migrated.days[0].events[0].type, migrated.days[0].events[0].countedWaterMl], [23, "BALANCE_LIQUID", 23]);
}

{
  const oldSettings = clone(DEFAULT_SETTINGS);
  oldSettings.schemaVersion = 3;
  oldSettings.foods.balanceLiquid.name = "バランスリキッド";
  oldSettings.foods.balanceLiquid.countedWaterMl = 18;
  delete oldSettings.foods.balanceLiquid.addedWaterMl;
  const oldDay = day(oldSettings);
  const oldState = { schemaVersion: 3, settings: clone(oldSettings), days: [oldDay], updatedAt: morning.toISOString() };
  const migrated = migrateStateToCurrent(clone(oldState));
  const merged = mergeFamilyStates(oldState, migrated, oldState);
  check("schema 3移行: ローカル・Supabaseとも将来設定だけ23 mlへ変更", [
    migrated.settings.foods.balanceLiquid.countedWaterMl,
    migrated.days[0].settingsSnapshot.foods.balanceLiquid.countedWaterMl,
    merged.state.settings.foods.balanceLiquid.countedWaterMl,
    merged.state.days[0].settingsSnapshot.foods.balanceLiquid.countedWaterMl
  ], [23, 18, 23, 18]);
}

{
  check("点眼タイマーは絶対時刻から残り時間を計算", [secondsUntil("2026-09-05T00:05:00.000Z", Date.parse("2026-09-05T00:01:10.000Z")), formatCountdown(230)], [230, "03:50"]);
  const validation = validateEyeDropSettings(
    [{ id: "one", name: "1", requiredDailyCount: 2 }],
    [{ time: "06:00", steps: ["one"] }, { time: "08:00", steps: ["one"] }]
  );
  const invalid = validateEyeDropSettings(
    [{ id: "one", name: "1", requiredDailyCount: -1 }, { id: "two", name: "1", requiredDailyCount: 1 }],
    [{ time: "07:00", steps: ["missing"] }]
  );
  check("点眼設定: 必要回数を検証し不正な設定を拒否", [validation.errors.length, validation.countWarnings.length, validation.counts.one, invalid.errors.length > 0], [0, 0, 2, true]);
}

{
  const token = "a".repeat(64);
  check("招待: 完全なURLとトークン単体を受け付ける", [inviteTokenFromInput(`https://example.com/app/#invite=${token}`), inviteTokenFromInput(token)], [token, token]);
}

{
  const d = day();
  const event = createEvent(d, "CHICKEN_MEAL", morning.toISOString());
  d.events.push(event);
  event.status = "VOIDED";
  check("T20 取消しイベントは集計から除外", summarizeDay(d).actualCaloriesTenthKcal, 0);
}

{
  const settings = clone(DEFAULT_SETTINGS);
  settings.calorieTargetTenthKcal = 240;
  let d = day(settings);
  check("残り24.0 kcalは1回", recalculatePlan(d, morning).recommendedRemainingDoses, 1);
  settings.calorieTargetTenthKcal = 241;
  d = day(settings);
  check("残り24.1 kcalは2回", recalculatePlan(d, morning).recommendedRemainingDoses, 2);
}


{
  check("固形食: 10g・54粒・29kcalが同じ記録値", [solidFoodNutrition(10, "g").caloriesTenthKcal,
    solidFoodNutrition(54, "pieces").caloriesTenthKcal, solidFoodNutrition(29).caloriesTenthKcal], [290, 290, 290]);
  check("固形食: 1粒は0.1kcal単位に四捨五入", solidFoodNutrition(1, "pieces").caloriesTenthKcal, 5);
  let rejected = false;
  try { solidFoodNutrition(1.5, "pieces"); } catch { rejected = true; }
  check("固形食: 小数の粒数を拒否", rejected, true);
  check("スープ缶: 入力量から0.5kcal/mlで計算", [soupNutrition(15), soupNutrition(3.2)], [
    { caloriesTenthKcal: 75, countedWaterMl: 15 }, { caloriesTenthKcal: 16, countedWaterMl: 3.2 }
  ]);
  const e = createEvent(day(), "SOLID_FOOD", morning.toISOString(), solidFoodNutrition(54, "pieces"));
  check("固形食: 入力単位のスナップショットを保持", [e.inputAmount, e.inputUnit, e.countedWaterMl], [54, "pieces", 0]);
}

{
  const d = day();
  d.settingsSnapshot.medicine.scheduledTimes = ["07:30", "13:00"];
  const state = { schemaVersion: 5, settings: clone(d.settingsSnapshot), days: [d], updatedAt: morning.toISOString() };
  const migrated = migrateStateToCurrent(clone(state));
  check("薬: 保存・移行後も設定した2時刻を保持", migrated.days[0].settingsSnapshot.medicine.scheduledTimes, ["07:30", "13:00"]);
  const dose = createEvent(d, "VOMIT_BUSTER", morning.toISOString());
  dose.medicineScheduledTime = "06:00";
  dose.medicineDoseIndex = 0;
  d.events.push(dose);
  check("薬: 予定時刻変更後も記録済みの1回目を対応付ける", medicineSchedule(d).doses.map((item) => Boolean(item.event)), [true, false]);
  check("薬: 時刻を変更しても未投与予約水分を保持", summarizeDay(d).reservedMedicineWaterMl, 5);
}

{
  const d = day();
  const legacy = { schemaVersion: 4, settings: clone(DEFAULT_SETTINGS), days: [d], updatedAt: morning.toISOString() };
  legacy.settings.foods.balanceLiquid.name = "通常セット";
  legacy.settings.foods.soupSyringe = { caloriesTenthKcal: 40, countedWaterMl: 10 };
  d.settingsSnapshot.foods.soupSyringe = { caloriesTenthKcal: 40, countedWaterMl: 10 };
  add(d, "SOUP_SYRINGE");
  const m = migrateStateToCurrent(clone(legacy));
  check("schema4移行: 名称を戻し既存の管理水分は保持", [m.schemaVersion, m.settings.foods.balanceLiquid.name, m.settings.foods.balanceLiquid.countedWaterMl], [5, "バランスリキッド", 23]);
  check("schema4移行: 過去スープの設定と実績を保護", [m.settings.foods.soupSyringe.caloriesTenthKcal, m.days[0].settingsSnapshot.foods.soupSyringe.caloriesTenthKcal, m.days[0].events[0].caloriesTenthKcal], [75, 40, 40]);
}

{
  const d = day();
  const base = { schemaVersion: 5, settings: clone(DEFAULT_SETTINGS), days: [d], updatedAt: morning.toISOString() };
  const local = clone(base);
  const remote = clone(base);
  setSlotManualState(local.days[0].slots[0], "SKIPPED", "休憩", "2026-08-28T00:00:00Z");
  remote.days[0].slots[0].status = "OVERDUE";
  remote.days[0].slots[0].updatedAt = "2026-08-28T01:00:00Z";
  const merged = mergeFamilyStates(remote, local, base);
  recalculatePlan(merged.state.days[0], at11);
  check("同期: 後から再計算された予定でもスキップを保持", merged.state.days[0].slots[0].status, "SKIPPED");
  const reset = clone(merged.state);
  setSlotManualState(reset.days[0].slots[0], null, "戻す", "2026-08-28T02:00:00Z");
  const restored = mergeFamilyStates(merged.state, reset, merged.state);
  recalculatePlan(restored.state.days[0], at11);
  check("同期: 明示的なスキップ解除も保持", restored.state.days[0].slots[0].status, "OVERDUE");
  const stamp = d.updatedAt;
  recalculatePlan(d, at11);
  check("表示だけの再計算は日次設定の更新時刻を変えない", d.updatedAt, stamp);
}

{
  const d = day(); add(d, "BALANCE_LIQUID");
  const base = { schemaVersion: 5, settings: clone(DEFAULT_SETTINGS), days: [d], updatedAt: morning.toISOString() };
  const remote = clone(base), local = clone(base);
  local.days[0].events[0].caloriesTenthKcal = 300;
  local.days[0].events[0].countedWaterMl = 25;
  // Clock skew must not discard a change when only one side edited the event.
  local.days[0].events[0].updatedAt = "2000-01-01T00:00:00Z";
  const merged = mergeFamilyStates(remote, local, base);
  check("同期: 片側だけのkcal・水分同時編集を時計差に関係なく保持", [merged.state.days[0].events[0].caloriesTenthKcal, merged.state.days[0].events[0].countedWaterMl], [300, 25]);
}

{
  const settings = clone(DEFAULT_SETTINGS);
  settings.medicine.scheduledTimes = [];
  const legacy = migrateStateToCurrent({ schemaVersion: 1, settings, days: [] });
  check("旧schema: 空の薬時刻は2回の既定値へ復元", legacy.settings.medicine.scheduledTimes, ["06:00", "12:00"]);
}

const passed = results.filter((result) => result.pass).length;
summaryNode.innerHTML = `<strong>${passed} / ${results.length} 件合格</strong><p class="slot-meta">${passed === results.length ? "すべての計算テストに合格しました。" : "不合格の項目を確認してください。"}</p>`;
resultNode.innerHTML = results.map((result) => `<div class="alert ${result.pass ? "info" : "critical"}"><span class="alert-icon">${result.pass ? "✓" : "!"}</span><div><strong>${result.name}</strong>${result.pass ? "" : `<p>期待: ${JSON.stringify(result.expected)} / 実際: ${JSON.stringify(result.actual)}</p>`}</div></div>`).join("");
document.documentElement.dataset.tests = passed === results.length ? "passed" : "failed";
