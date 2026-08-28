export const SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  dogName: "",
  timezone: "Asia/Tokyo",
  calorieTargetTenthKcal: 1980,
  waterLimitMl: 200,
  foods: {
    normalSet: {
      name: "通常セット",
      balanceLiquidMl: 18,
      addedWaterMl: 5,
      caloriesTenthKcal: 240,
      countedWaterMl: 23,
      indivisible: true
    },
    chickenMeal: {
      name: "鶏のスープごはん",
      servingLabel: "1食",
      caloriesTenthKcal: 399,
      countedWaterMl: 0
    },
    soupSyringe: {
      name: "スープ缶シリンジ",
      caloriesTenthKcal: 40,
      countedWaterMl: 10
    }
  },
  medicine: {
    name: "ボミットバスター",
    doseMl: 5,
    dosesPerDay: 2,
    caloriesTenthKcal: 0,
    scheduledTimes: ["06:00", "12:00"]
  },
  regularSlotTimes: ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"],
  adjustmentSlotTime: "22:00"
});

export const EVENT_LABELS = {
  NORMAL_SET: "通常セット",
  CHICKEN_MEAL: "鶏のスープごはん",
  VOMIT_BUSTER: "薬",
  SOUP_SYRINGE: "スープ缶シリンジ"
};

export const STATUS_LABELS = {
  PLANNED: "予定",
  COMPLETED: "完了",
  NOT_REQUIRED: "不要",
  SKIPPED: "スキップ",
  FAILED: "失敗",
  OVERDUE: "遅延",
  ADJUSTMENT_AVAILABLE: "調整待ち"
};
