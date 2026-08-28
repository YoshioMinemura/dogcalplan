import { clone, createDay, createEvent, recalculatePlan, selectEvenly, summarizeDay } from "./domain.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { mergeFamilyStates } from "./sync.js";
import { getSupabaseClient } from "./supabase-client.js";

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
  check("T01 新規日は8セット、192 kcal、薬込み194 ml", [s.recommendedRemainingSets, s.predictedCaloriesTenthKcal, s.predictedWaterMl], [8, 1920, 194]);
  check("T01 22時は通常予定にしない", d.slots.find((slot) => slot.role === "ADJUSTMENT").status, "ADJUSTMENT_AVAILABLE");
}

[
  [1, 7, 2079, 171], [2, 5, 1998, 125], [3, 4, 2157, 102], [4, 2, 2076, 56], [5, 0, 1995, 10]
].forEach(([chicken, sets, calories, water]) => {
  const d = day();
  add(d, "CHICKEN_MEAL", chicken);
  const s = recalculatePlan(d, morning);
  check(`T04-T08 鶏ごはん${chicken}食`, [s.recommendedRemainingSets, s.predictedCaloriesTenthKcal, s.predictedWaterMl], [sets, calories, water]);
});

{
  const d = day();
  const completed = d.slots.slice(0, 3);
  add(d, "NORMAL_SET", 3, completed);
  add(d, "CHICKEN_MEAL");
  const s1 = recalculatePlan(d, at11);
  check("T09 3セット後に鶏1食で未来4セット", [s1.completedNormalSets, s1.recommendedRemainingSets], [3, 4]);
  add(d, "CHICKEN_MEAL");
  const s2 = recalculatePlan(d, at11);
  check("T10 さらに鶏1食で未来2セット", [s2.completedNormalSets, s2.recommendedRemainingSets], [3, 2]);
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
  check("境界値 残り22 mlでは0セット", recalculatePlan(d, morning).recommendedRemainingSets, 0);
  d.settingsSnapshot.waterLimitMl = 33; // 予約10 + 残り23
  check("境界値 残り23 mlでは1セット", recalculatePlan(d, morning).recommendedRemainingSets, 1);
}

{
  const remote = { schemaVersion: 2, settings: clone(DEFAULT_SETTINGS), days: [day()], updatedAt: "2026-08-29T00:00:00.000Z" };
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
  const remote = { schemaVersion: 2, settings: clone(DEFAULT_SETTINGS), days: [remoteDay], updatedAt: "2026-08-29T00:00:00.000Z" };
  const local = { schemaVersion: 2, settings: clone(DEFAULT_SETTINGS), days: [localDay], updatedAt: "2026-08-29T00:01:00.000Z" };
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
  const localEvent = createEvent(localDay, "NORMAL_SET", "2026-08-28T00:00:00.000Z", { linkedSlotId: localDay.slots[0].id });
  localDay.events.push(localEvent);
  const merged = mergeFamilyStates(
    { schemaVersion: 2, settings: clone(DEFAULT_SETTINGS), days: [remoteDay], updatedAt: "2026-08-29T00:00:00.000Z" },
    { schemaVersion: 2, settings: clone(DEFAULT_SETTINGS), days: [localDay], updatedAt: "2026-08-29T00:01:00.000Z" }
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
  const base = { schemaVersion: 2, settings: clone(DEFAULT_SETTINGS), days: [], updatedAt: "2026-08-29T00:00:00.000Z" };
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
  const event = createEvent(d, "CHICKEN_MEAL", morning.toISOString());
  d.events.push(event);
  event.status = "VOIDED";
  check("T20 取消しイベントは集計から除外", summarizeDay(d).actualCaloriesTenthKcal, 0);
}

{
  const settings = clone(DEFAULT_SETTINGS);
  settings.calorieTargetTenthKcal = 240;
  let d = day(settings);
  check("残り24.0 kcalは1セット", recalculatePlan(d, morning).recommendedRemainingSets, 1);
  settings.calorieTargetTenthKcal = 241;
  d = day(settings);
  check("残り24.1 kcalは2セット", recalculatePlan(d, morning).recommendedRemainingSets, 2);
}

const passed = results.filter((result) => result.pass).length;
summaryNode.innerHTML = `<strong>${passed} / ${results.length} 件合格</strong><p class="slot-meta">${passed === results.length ? "すべての計算テストに合格しました。" : "不合格の項目を確認してください。"}</p>`;
resultNode.innerHTML = results.map((result) => `<div class="alert ${result.pass ? "info" : "critical"}"><span class="alert-icon">${result.pass ? "✓" : "!"}</span><div><strong>${result.name}</strong>${result.pass ? "" : `<p>期待: ${JSON.stringify(result.expected)} / 実際: ${JSON.stringify(result.actual)}</p>`}</div></div>`).join("");
document.documentElement.dataset.tests = passed === results.length ? "passed" : "failed";
