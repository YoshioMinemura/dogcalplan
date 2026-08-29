import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "./defaults.js";

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function uid(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function localDateInTimezone(date = new Date(), timezone = "Asia/Tokyo") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function timeInTimezone(date = new Date(), timezone = "Asia/Tokyo") {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: clone(DEFAULT_SETTINGS),
    days: [],
    updatedAt: new Date().toISOString()
  };
}

export function migrateSettingsToCurrent(settings) {
  if (!settings) return settings;
  settings.foods ||= {};
  if (!settings.foods.balanceLiquid) {
    const old = settings.foods.normalSet || {};
    const amountMl = Number.isFinite(old.balanceLiquidMl) ? old.balanceLiquidMl : 18;
    settings.foods.balanceLiquid = {
      name: "バランスリキッド",
      amountMl,
      caloriesTenthKcal: Number.isFinite(old.caloriesTenthKcal) ? old.caloriesTenthKcal : 240,
      countedWaterMl: amountMl,
      indivisible: true
    };
  }
  settings.foods.balanceLiquid.name = "バランスリキッド";
  const migratedAmountMl = Number.isFinite(settings.foods.balanceLiquid.amountMl)
    ? settings.foods.balanceLiquid.amountMl
    : settings.foods.balanceLiquid.countedWaterMl;
  settings.foods.balanceLiquid.amountMl = Number.isFinite(migratedAmountMl) && migratedAmountMl > 0
    ? migratedAmountMl
    : 18;
  settings.foods.balanceLiquid.countedWaterMl = settings.foods.balanceLiquid.amountMl;
  settings.schemaVersion = SCHEMA_VERSION;
  delete settings.foods.normalSet;
  if (settings.medicine) {
    settings.medicine.dosesPerDay = 2;
    settings.medicine.scheduledTimes = ["06:00", "12:00"];
    delete settings.medicine.optionalScheduledTimes;
  }
  return settings;
}

export function migrateStateToCurrent(loaded) {
  loaded.schemaVersion = SCHEMA_VERSION;
  migrateSettingsToCurrent(loaded.settings);
  for (const day of loaded.days || []) {
    migrateSettingsToCurrent(day.settingsSnapshot);
    for (const slot of day.slots || []) {
      if (slot.plannedType === "NORMAL_SET") slot.plannedType = "BALANCE_LIQUID";
      if (slot.changeReason) slot.changeReason = slot.changeReason.replaceAll("通常セット", "バランスリキッド");
    }
    for (const event of day.events || []) {
      if (event.type === "NORMAL_SET") {
        event.type = "BALANCE_LIQUID";
        event.legacyNormalSet = true;
      }
    }
    for (const revision of day.planRevisions || []) {
      if (revision.reason) revision.reason = revision.reason.replaceAll("通常セット", "バランスリキッド");
    }
  }
  return loaded;
}

export function createDay(localDate, settings, now = new Date()) {
  const stamp = now.toISOString();
  const dayId = uid("day");
  const slots = [
    ...settings.regularSlotTimes.map((scheduledTime) => ({
      id: uid("slot"), dayId, scheduledTime, role: "REGULAR", status: "PLANNED",
      plannedType: "BALANCE_LIQUID", revision: 1, updatedAt: stamp
    })),
    {
      id: uid("slot"), dayId, scheduledTime: settings.adjustmentSlotTime,
      role: "ADJUSTMENT", status: "ADJUSTMENT_AVAILABLE", revision: 1, updatedAt: stamp
    }
  ];
  return {
    id: dayId,
    localDate,
    timezone: settings.timezone,
    settingsSnapshot: clone(settings),
    note: "",
    events: [],
    slots,
    planRevisions: [],
    createdAt: stamp,
    updatedAt: stamp
  };
}

export function eventNutrition(type, settings) {
  switch (type) {
    case "NORMAL_SET":
    case "BALANCE_LIQUID": return {
      caloriesTenthKcal: settings.foods.balanceLiquid.caloriesTenthKcal,
      countedWaterMl: settings.foods.balanceLiquid.countedWaterMl
    };
    case "CHICKEN_MEAL": return {
      caloriesTenthKcal: settings.foods.chickenMeal.caloriesTenthKcal,
      countedWaterMl: settings.foods.chickenMeal.countedWaterMl
    };
    case "VOMIT_BUSTER": return {
      caloriesTenthKcal: settings.medicine.caloriesTenthKcal,
      countedWaterMl: settings.medicine.doseMl
    };
    case "SOUP_SYRINGE": return {
      caloriesTenthKcal: settings.foods.soupSyringe.caloriesTenthKcal,
      countedWaterMl: settings.foods.soupSyringe.countedWaterMl
    };
    case "PLAIN_WATER": return { caloriesTenthKcal: 0, countedWaterMl: 0 };
    case "SOLID_FOOD": return { caloriesTenthKcal: 0, countedWaterMl: 0 };
    default: throw new Error(`Unknown event type: ${type}`);
  }
}

export function createEvent(day, type, occurredAt, options = {}) {
  const stamp = new Date().toISOString();
  const nutrition = eventNutrition(type, day.settingsSnapshot);
  if (Number.isFinite(options.caloriesTenthKcal)) nutrition.caloriesTenthKcal = options.caloriesTenthKcal;
  if (Number.isFinite(options.countedWaterMl)) nutrition.countedWaterMl = options.countedWaterMl;
  return {
    id: uid("event"), dayId: day.id, type, occurredAt,
    linkedSlotId: options.linkedSlotId || undefined,
    ...nutrition, quantity: 1, note: options.note?.trim() || "",
    status: "ACTIVE", createdAt: stamp, updatedAt: stamp
  };
}

export function summarizeDay(day) {
  const settings = day.settingsSnapshot;
  const active = day.events.filter((event) => event.status === "ACTIVE");
  const actualCaloriesTenthKcal = active.reduce((sum, event) => sum + event.caloriesTenthKcal * event.quantity, 0);
  const actualWaterMl = active.reduce((sum, event) => sum + event.countedWaterMl * event.quantity, 0);
  const completedMedicineDoses = active.filter((event) => event.type === "VOMIT_BUSTER").length;
  const remainingMedicineDoses = Math.max(0, settings.medicine.dosesPerDay - completedMedicineDoses);
  const reservedMedicineWaterMl = remainingMedicineDoses * settings.medicine.doseMl;
  const projectedCommittedWaterMl = actualWaterMl + reservedMedicineWaterMl;
  const safeRemainingWaterMl = settings.waterLimitMl - projectedCommittedWaterMl;
  const chickenMealCount = active.filter((event) => event.type === "CHICKEN_MEAL").length;
  const completedBalanceLiquidDoses = active.filter((event) => ["BALANCE_LIQUID", "NORMAL_SET"].includes(event.type)).length;
  return {
    actualCaloriesTenthKcal, actualWaterMl, completedMedicineDoses,
    remainingMedicineDoses, reservedMedicineWaterMl, projectedCommittedWaterMl,
    safeRemainingWaterMl, chickenMealCount, completedBalanceLiquidDoses
  };
}

export function medicineSchedule(day) {
  const scheduledTimes = day.settingsSnapshot.medicine.scheduledTimes || ["06:00", "12:00"];
  const activeEvents = day.events
    .filter((event) => event.status === "ACTIVE" && event.type === "VOMIT_BUSTER")
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const assigned = new Map();
  for (const event of activeEvents) {
    if (scheduledTimes.includes(event.medicineScheduledTime) && !assigned.has(event.medicineScheduledTime)) {
      assigned.set(event.medicineScheduledTime, event);
    }
  }
  for (const event of activeEvents) {
    if ([...assigned.values()].includes(event)) continue;
    const nextTime = scheduledTimes.find((time) => !assigned.has(time));
    if (nextTime) assigned.set(nextTime, event);
  }
  return {
    doses: scheduledTimes.map((scheduledTime) => ({ scheduledTime, event: assigned.get(scheduledTime) || null })),
    extraEvents: activeEvents.filter((event) => ![...assigned.values()].includes(event))
  };
}

function slotDateValue(day, time) {
  return `${day.localDate}T${time}:00`;
}

export function isSlotFuture(day, slot, now = new Date()) {
  const today = localDateInTimezone(now, day.timezone);
  if (day.localDate > today) return true;
  if (day.localDate < today) return false;
  return slot.scheduledTime >= timeInTimezone(now, day.timezone);
}

export function selectEvenly(slots, count) {
  if (count <= 0) return [];
  if (count >= slots.length) return [...slots];
  const selected = [];
  const baseSize = Math.floor(slots.length / count);
  const remainder = slots.length % count;
  let cursor = 0;
  for (let group = 0; group < count; group += 1) {
    const size = baseSize + (group < remainder ? 1 : 0);
    cursor += size;
    selected.push(slots[cursor - 1]);
  }
  return selected;
}

export function recalculatePlan(day, now = new Date(), reason = "再計算", recordRevision = false) {
  const settings = day.settingsSnapshot;
  const summary = summarizeDay(day);
  const stamp = now.toISOString();
  const activeLinkedIds = new Set(day.events.filter((e) => e.status === "ACTIVE" && e.linkedSlotId).map((e) => e.linkedSlotId));
  const terminal = new Set(["SKIPPED", "FAILED"]);

  for (const slot of day.slots) {
    if (activeLinkedIds.has(slot.id)) {
      slot.status = "COMPLETED";
      slot.linkedEventId = day.events.find((event) => event.status === "ACTIVE" && event.linkedSlotId === slot.id)?.id;
      continue;
    }
    if (slot.status === "COMPLETED") {
      slot.status = slot.role === "ADJUSTMENT" ? "ADJUSTMENT_AVAILABLE" : "PLANNED";
      delete slot.linkedEventId;
    }
    if (terminal.has(slot.status)) continue;
    if (!isSlotFuture(day, slot, now) && slot.status === "PLANNED") slot.status = "OVERDUE";
  }

  const regularFuture = day.slots
    .filter((slot) => slot.role === "REGULAR" && !terminal.has(slot.status) && slot.status !== "COMPLETED" && isSlotFuture(day, slot, now))
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  const adjustment = day.slots.find((slot) => slot.role === "ADJUSTMENT");
  const adjustmentAvailable = adjustment && !terminal.has(adjustment.status) && adjustment.status !== "COMPLETED" && isSlotFuture(day, adjustment, now);

  const remainingCalories = Math.max(0, settings.calorieTargetTenthKcal - summary.actualCaloriesTenthKcal);
  const balanceCalories = settings.foods.balanceLiquid.caloriesTenthKcal;
  const balanceWater = settings.foods.balanceLiquid.countedWaterMl;
  const dosesNeededForCalories = remainingCalories === 0 ? 0 : Math.ceil(remainingCalories / balanceCalories);
  const dosesAllowedByWater = Math.max(0, Math.floor(summary.safeRemainingWaterMl / balanceWater));
  const dosesAllowedBySlots = regularFuture.length + (adjustmentAvailable ? 1 : 0);
  const recommendedRemainingDoses = Math.min(dosesNeededForCalories, dosesAllowedByWater, dosesAllowedBySlots);

  let selected = [];
  if (recommendedRemainingDoses <= regularFuture.length) {
    selected = selectEvenly(regularFuture, recommendedRemainingDoses);
  } else {
    selected = [...regularFuture];
    if (adjustmentAvailable) selected.push(adjustment);
  }
  const selectedIds = new Set(selected.map((slot) => slot.id));
  const changed = [];
  for (const slot of day.slots) {
    if (terminal.has(slot.status) || slot.status === "COMPLETED" || !isSlotFuture(day, slot, now)) continue;
    const next = selectedIds.has(slot.id)
      ? "PLANNED"
      : slot.role === "ADJUSTMENT" ? "ADJUSTMENT_AVAILABLE" : "NOT_REQUIRED";
    if (slot.status !== next) {
      changed.push({ slotId: slot.id, time: slot.scheduledTime, from: slot.status, to: next });
      slot.status = next;
      slot.changeReason = reason;
      slot.revision += 1;
      slot.updatedAt = stamp;
    }
  }
  if (recordRevision && changed.length) {
    day.planRevisions.push({ id: uid("revision"), occurredAt: stamp, reason, changes: changed });
  }

  const predictedCaloriesTenthKcal = summary.actualCaloriesTenthKcal + recommendedRemainingDoses * balanceCalories;
  const predictedWaterMl = summary.projectedCommittedWaterMl + recommendedRemainingDoses * balanceWater;
  const calorieReachable = predictedCaloriesTenthKcal >= settings.calorieTargetTenthKcal;
  const waterSafe = predictedWaterMl <= settings.waterLimitMl;
  const warnings = buildWarnings(day, {
    ...summary, remainingCalories, dosesNeededForCalories, dosesAllowedByWater,
    dosesAllowedBySlots, recommendedRemainingDoses, predictedCaloriesTenthKcal,
    predictedWaterMl, calorieReachable, waterSafe
  }, now);
  day.updatedAt = stamp;
  return {
    ...summary, remainingCalories, dosesNeededForCalories, dosesAllowedByWater,
    dosesAllowedBySlots, recommendedRemainingDoses, predictedCaloriesTenthKcal,
    predictedWaterMl, calorieReachable, waterSafe, warnings
  };
}

export function buildWarnings(day, summary, now = new Date()) {
  const warnings = [];
  const s = day.settingsSnapshot;
  if (summary.projectedCommittedWaterMl > s.waterLimitMl) {
    warnings.push({ level: "critical", title: "水分上限を超えています", message: `未投与の薬を含む見込みが ${summary.projectedCommittedWaterMl} ml です。対応は獣医師の指示を確認してください。` });
  } else if (summary.actualCaloriesTenthKcal >= s.calorieTargetTenthKcal) {
    warnings.push({ level: "info", title: "カロリー目標に到達", message: "本日のカロリー目標に到達しました。" });
  } else if (!summary.calorieReachable) {
    const shortage = s.calorieTargetTenthKcal - summary.predictedCaloriesTenthKcal;
    const waterBlocked = summary.dosesAllowedByWater < summary.dosesNeededForCalories
      && summary.dosesAllowedByWater <= summary.dosesAllowedBySlots;
    warnings.push({
      level: "info",
      title: "目標まで届かない見込みです",
      message: waterBlocked
        ? `見込みは ${formatKcal(summary.predictedCaloriesTenthKcal)} kcal。目標まで ${formatKcal(shortage)} kcalですが、水分上限のためバランスリキッドを追加しません。`
        : `見込みは ${formatKcal(summary.predictedCaloriesTenthKcal)} kcal。残り時間枠では目標に到達できません。`
    });
  }
  const today = localDateInTimezone(now, day.timezone);
  const time = timeInTimezone(now, day.timezone);
  if (day.localDate === today) {
    const missedTimes = medicineSchedule(day).doses
      .filter((dose) => dose.scheduledTime < time && !dose.event)
      .map((dose) => dose.scheduledTime);
    if (missedTimes.length > 0) {
      warnings.push({ level: "caution", title: `薬が${missedTimes.length}回未記録`, message: `${missedTimes.join("・")}の予定が未記録です。投与については獣医師の指示を確認してください。` });
    }
  }
  const overdueCount = day.slots.filter((slot) => slot.status === "OVERDUE").length;
  if (overdueCount) warnings.push({ level: "caution", title: `予定が${overdueCount}件遅延`, message: "遅れて与えた場合も、該当カードから記録できます。" });
  return warnings;
}

export function formatKcal(tenthKcal) {
  return Number.isInteger(tenthKcal / 10) ? String(tenthKcal / 10) : (tenthKcal / 10).toFixed(1);
}

export function formatDateJa(localDate, includeYear = false) {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "UTC" }).format(date);
  return `${includeYear ? `${year}年` : ""}${month}月${day}日（${weekday}）`;
}

export function reasonForType(type) {
  return ({ BALANCE_LIQUID: "バランスリキッド完了", PLAIN_WATER: "飲水記録", SOLID_FOOD: "固形食摂取", CHICKEN_MEAL: "鶏ごはん摂取", VOMIT_BUSTER: "薬記録", SOUP_SYRINGE: "スープ缶記録" })[type] || "実績編集";
}
