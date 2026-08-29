import { createHousehold, findCurrentHousehold, inviteTokenFromInput, inviteTokenFromLocation, joinWithInvite } from "./auth.js";
import { loadSyncMetadata, saveSyncMetadata } from "./db.js";
import { getSupabaseClient } from "./supabase-client.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const timestamp = (value) => Date.parse(value || "") || 0;
const entityTime = (value) => timestamp(value?.updatedAt || value?.createdAt);

function chooseValue(remote, local, base, conflicts, label, remoteTime = entityTime(remote), localTime = entityTime(local)) {
  if (equal(remote, local)) return clone(remote);
  const localChanged = base !== undefined && !equal(local, base);
  const remoteChanged = base !== undefined && !equal(remote, base);
  if (localChanged && remoteChanged) conflicts.push(`${label}は別端末でも変更されたため、新しい方を採用しました。`);
  if (base === undefined) return clone(remote);
  if (localChanged && !remoteChanged) return clone(local);
  if (!localChanged && remoteChanged) return clone(remote);
  return localTime > remoteTime ? clone(local) : clone(remote);
}

function keyed(items, key) {
  return new Map((items || []).map((item) => [key(item), item]));
}

function mergeEntityMaps(remoteItems, localItems, baseItems, key, conflicts, label) {
  const remote = keyed(remoteItems, key);
  const local = keyed(localItems, key);
  const base = keyed(baseItems, key);
  const keys = new Set([...remote.keys(), ...local.keys()]);
  const merged = [];
  for (const id of keys) {
    const remoteValue = remote.get(id);
    const localValue = local.get(id);
    if (!remoteValue) { merged.push(clone(localValue)); continue; }
    if (!localValue) { merged.push(clone(remoteValue)); continue; }
    if (equal(remoteValue, localValue)) { merged.push(clone(remoteValue)); continue; }
    const baseValue = base.get(id);
    const localChanged = baseValue && !equal(localValue, baseValue);
    const remoteChanged = baseValue && !equal(remoteValue, baseValue);
    if (localChanged && remoteChanged) conflicts.push(`${label}が別端末でも編集されたため、新しい更新を採用しました。`);
    merged.push(clone(entityTime(localValue) > entityTime(remoteValue) ? localValue : remoteValue));
  }
  return merged;
}

function resolveDuplicateEvents(day, remoteEventIds, conflicts) {
  const active = day.events.filter((event) => event.status === "ACTIVE");
  const groups = new Map();
  for (const event of active) {
    let key = null;
    if (["BALANCE_LIQUID", "NORMAL_SET"].includes(event.type) && event.linkedSlotId) key = `slot:${event.linkedSlotId}`;
    if (event.type === "VOMIT_BUSTER" && event.medicineScheduledTime) key = `medicine:${event.medicineScheduledTime}`;
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(event);
    groups.set(key, list);
  }
  for (const [key, events] of groups) {
    if (events.length < 2) continue;
    events.sort((left, right) => {
      const remoteDifference = Number(remoteEventIds.has(right.id)) - Number(remoteEventIds.has(left.id));
      return remoteDifference || entityTime(left) - entityTime(right) || left.id.localeCompare(right.id);
    });
    const kept = events[0];
    for (const duplicate of events.slice(1)) {
      duplicate.status = "VOIDED";
      duplicate.voidReason = "同期競合: 別端末で同じ予定を記録済み";
      duplicate.updatedAt = new Date(Math.max(entityTime(duplicate), entityTime(kept))).toISOString();
    }
    const target = key.startsWith("medicine:") ? `${key.slice(9)}の薬` : "同じバランスリキッド枠";
    conflicts.push(`${target}が別端末でも記録されていたため、先に同期された1件だけを有効にしました。`);
  }
}

function mergeDay(remoteDay, localDay, baseDay, conflicts) {
  if (!remoteDay) return clone(localDay);
  if (!localDay) return clone(remoteDay);

  const result = clone(remoteDay);
  const remoteSlots = keyed(remoteDay.slots, (slot) => `${slot.scheduledTime}|${slot.role}`);
  const localSlots = keyed(localDay.slots, (slot) => `${slot.scheduledTime}|${slot.role}`);
  const baseSlots = baseDay?.slots || [];
  result.slots = mergeEntityMaps(
    remoteDay.slots,
    localDay.slots,
    baseSlots,
    (slot) => `${slot.scheduledTime}|${slot.role}`,
    conflicts,
    `${remoteDay.localDate}の予定枠`
  ).map((slot) => {
    const canonical = remoteSlots.get(`${slot.scheduledTime}|${slot.role}`);
    return { ...slot, id: canonical?.id || slot.id, dayId: remoteDay.id };
  });

  const slotIdByKey = new Map(result.slots.map((slot) => [`${slot.scheduledTime}|${slot.role}`, slot.id]));
  const localSlotKeyById = new Map([...localSlots.entries()].map(([key, slot]) => [slot.id, key]));
  const remoteSlotKeyById = new Map([...remoteSlots.entries()].map(([key, slot]) => [slot.id, key]));
  const canonicalizeEvent = (event, source) => {
    const copy = clone(event);
    const slotKey = source === "local" ? localSlotKeyById.get(copy.linkedSlotId) : remoteSlotKeyById.get(copy.linkedSlotId);
    if (slotKey) copy.linkedSlotId = slotIdByKey.get(slotKey);
    copy.dayId = remoteDay.id;
    return copy;
  };
  const remoteEvents = remoteDay.events.map((event) => canonicalizeEvent(event, "remote"));
  const localEvents = localDay.events.map((event) => canonicalizeEvent(event, "local"));
  const baseEvents = baseDay?.events || [];
  result.events = mergeEntityMaps(remoteEvents, localEvents, baseEvents, (event) => event.id, conflicts, `${remoteDay.localDate}の実績`);
  resolveDuplicateEvents(result, new Set(remoteEvents.map((event) => event.id)), conflicts);

  result.planRevisions = mergeEntityMaps(
    remoteDay.planRevisions,
    localDay.planRevisions,
    baseDay?.planRevisions || [],
    (revision) => revision.id,
    conflicts,
    `${remoteDay.localDate}の予定変更`
  );
  result.settingsSnapshot = chooseValue(
    remoteDay.settingsSnapshot,
    localDay.settingsSnapshot,
    baseDay?.settingsSnapshot,
    conflicts,
    `${remoteDay.localDate}の当日設定`,
    entityTime(remoteDay),
    entityTime(localDay)
  );
  result.timezone = result.settingsSnapshot?.timezone || remoteDay.timezone;
  result.note = chooseValue(
    remoteDay.note || "",
    localDay.note || "",
    baseDay?.note,
    conflicts,
    `${remoteDay.localDate}のメモ`,
    entityTime(remoteDay),
    entityTime(localDay)
  );
  result.updatedAt = new Date(Math.max(entityTime(remoteDay), entityTime(localDay))).toISOString();
  return result;
}

export function mergeFamilyStates(remoteState, localState, baseState = null) {
  if (!remoteState) return { state: clone(localState), conflicts: [] };
  if (!localState) return { state: clone(remoteState), conflicts: [] };
  const conflicts = [];
  const result = clone(remoteState);
  result.settings = chooseValue(
    remoteState.settings,
    localState.settings,
    baseState?.settings,
    conflicts,
    "設定",
    timestamp(remoteState.updatedAt),
    timestamp(localState.updatedAt)
  );

  const remoteDays = keyed(remoteState.days, (day) => day.localDate);
  const localDays = keyed(localState.days, (day) => day.localDate);
  const baseDays = keyed(baseState?.days, (day) => day.localDate);
  result.days = [...new Set([...remoteDays.keys(), ...localDays.keys()])]
    .sort()
    .map((date) => mergeDay(remoteDays.get(date), localDays.get(date), baseDays.get(date), conflicts));
  result.schemaVersion = Math.max(remoteState.schemaVersion || 1, localState.schemaVersion || 1);
  result.updatedAt = new Date(Math.max(timestamp(remoteState.updatedAt), timestamp(localState.updatedAt))).toISOString();
  return { state: result, conflicts: [...new Set(conflicts)] };
}

function friendlyError(error) {
  if (!error) return "同期できませんでした";
  if (error.code === "PGRST202" || error.code === "42P01" || /function|relation/i.test(error.message || "")) {
    return "SupabaseのDB設定がまだ完了していません";
  }
  if (/invalid or revoked invite|invalid invite token/i.test(error.message || "")) return "招待URLが無効か、使用停止されています";
  if (/Failed to fetch|NetworkError|fetch/i.test(error.message || "")) return "オフラインのため同期待ちです";
  return error.message || "同期できませんでした";
}

export function createFamilySync({ getState, applyState, onStatus, onConflict }) {
  let client;
  let channel;
  let flushTimer;
  let flushing = false;
  let metadata = {
    householdId: null,
    revision: 0,
    lastSyncedState: null,
    pending: false,
    conflicts: [],
    inviteToken: "",
    lastSyncedAt: ""
  };

  const emit = (phase, message, error = false) => onStatus?.({
    phase,
    message,
    error,
    connected: Boolean(metadata.householdId),
    pending: metadata.pending,
    conflicts: metadata.conflicts,
    inviteUrl: getInviteUrl()
  });

  async function saveMetadata() {
    await saveSyncMetadata(metadata);
  }

  async function readRemote() {
    const { data, error } = await client
      .from("household_states")
      .select("state,revision,updated_at")
      .eq("household_id", metadata.householdId)
      .single();
    if (error) throw error;
    return data;
  }

  async function acceptSynced(state, revision) {
    metadata.revision = Number(revision);
    metadata.lastSyncedState = clone(state);
    metadata.pending = false;
    metadata.lastSyncedAt = new Date().toISOString();
    await saveMetadata();
    emit("synced", "家族と同期済み");
  }

  async function reconcile(remoteState, revision) {
    const localState = getState();
    const merged = mergeFamilyStates(remoteState, localState, metadata.lastSyncedState);
    if (merged.conflicts.length) {
      metadata.conflicts = [...new Set([...metadata.conflicts, ...merged.conflicts])].slice(-20);
      onConflict?.(merged.conflicts[0]);
    }
    metadata.revision = Number(revision);
    await applyState(merged.state);
    if (equal(merged.state, remoteState)) {
      await acceptSynced(remoteState, revision);
      return;
    }
    metadata.pending = true;
    await saveMetadata();
    await flush();
  }

  async function pull() {
    if (!metadata.householdId || !navigator.onLine) return;
    try {
      emit("syncing", "家族データを確認中…");
      const remote = await readRemote();
      if (Number(remote.revision) === metadata.revision && !metadata.pending) {
        emit("synced", "家族と同期済み");
        return;
      }
      await reconcile(remote.state, remote.revision);
    } catch (error) {
      emit("error", friendlyError(error), true);
    }
  }

  async function flush() {
    if (flushing || !metadata.householdId || !metadata.pending) return;
    if (!navigator.onLine) { emit("pending", "オフライン・同期待ち"); return; }
    flushing = true;
    try {
      emit("syncing", "家族へ同期中…");
      for (let attempt = 0; attempt < 3 && metadata.pending; attempt += 1) {
        const localState = clone(getState());
        const { data, error } = await client.rpc("save_household_state", {
          p_household_id: metadata.householdId,
          p_expected_revision: metadata.revision,
          p_state: localState
        });
        if (error) throw error;
        const result = data?.[0];
        if (!result) throw new Error("同期結果を確認できません");
        if (result.saved) {
          await acceptSynced(localState, result.current_revision);
        } else {
          const merged = mergeFamilyStates(result.current_state, localState, metadata.lastSyncedState);
          if (merged.conflicts.length) {
            metadata.conflicts = [...new Set([...metadata.conflicts, ...merged.conflicts])].slice(-20);
            onConflict?.(merged.conflicts[0]);
          }
          metadata.revision = Number(result.current_revision);
          await applyState(merged.state);
          metadata.pending = !equal(merged.state, result.current_state);
          if (!metadata.pending) await acceptSynced(result.current_state, result.current_revision);
        }
      }
      if (metadata.pending) throw new Error("同時更新が続いています。少し待って再試行してください");
    } catch (error) {
      metadata.pending = true;
      await saveMetadata().catch(() => {});
      emit("error", friendlyError(error), true);
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 250);
  }

  function subscribe() {
    if (channel) client.removeChannel(channel);
    channel = client
      .channel(`household-state:${metadata.householdId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "household_states",
        filter: `household_id=eq.${metadata.householdId}`
      }, (payload) => {
        if (Number(payload.new?.revision) > metadata.revision) pull();
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") emit("pending", "Realtime再接続中…", true);
      });
  }

  async function connect(household) {
    metadata.householdId = household.household_id;
    metadata.revision = Number(household.revision || 0);
    await saveMetadata();
    subscribe();
    const remote = await readRemote();
    await reconcile(remote.state, remote.revision);
  }

  async function initialize() {
    metadata = { ...metadata, ...(await loadSyncMetadata().catch(() => null) || {}) };
    const inviteToken = inviteTokenFromLocation();
    if (!navigator.onLine) {
      if (metadata.householdId) emit("pending", "オフライン・同期待ち");
      else if (inviteToken) emit("error", "招待への参加はオンラインで行ってください", true);
      else emit("local", "端末内に保存済み");
      return;
    }
    try {
      emit("connecting", inviteToken ? "家族データへ参加中…" : "同期へ接続中…");
      client = await getSupabaseClient();
      let household;
      if (inviteToken) {
        household = await joinWithInvite(client, inviteToken);
        metadata.lastSyncedState = null;
        metadata.conflicts = [];
        metadata.inviteToken = inviteToken;
      } else {
        household = await findCurrentHousehold(client);
      }
      if (!household) {
        metadata.householdId = null;
        await saveMetadata();
        emit("local", "端末内に保存済み");
        return;
      }
      await connect(household);
    } catch (error) {
      emit("error", friendlyError(error), true);
    }
  }

  async function joinFamily(inviteValue) {
    try {
      if (!navigator.onLine) throw new Error("家族への参加はオンラインで行ってください");
      const token = inviteTokenFromInput(inviteValue);
      emit("connecting", "家族データへ参加中…");
      client ||= await getSupabaseClient();
      const household = await joinWithInvite(client, token);
      metadata.lastSyncedState = null;
      metadata.conflicts = [];
      metadata.inviteToken = token;
      metadata.pending = false;
      await connect(household);
    } catch (error) {
      const message = friendlyError(error);
      emit("local", message, true);
      throw new Error(message);
    }
  }

  async function startFamily() {
    if (!navigator.onLine) throw new Error("家族同期の開始はオンラインで行ってください");
    emit("connecting", "家族データを作成中…");
    client ||= await getSupabaseClient();
    const created = await createHousehold(client, clone(getState()));
    metadata.householdId = created.household_id;
    metadata.revision = Number(created.revision);
    metadata.lastSyncedState = clone(getState());
    metadata.pending = false;
    metadata.inviteToken = created.token;
    metadata.lastSyncedAt = new Date().toISOString();
    await saveMetadata();
    subscribe();
    emit("synced", "家族同期を開始しました");
    return getInviteUrl();
  }

  async function queue() {
    if (!metadata.householdId) return;
    metadata.pending = true;
    await saveMetadata().catch(() => {});
    emit(navigator.onLine ? "pending" : "pending", navigator.onLine ? "同期待ち…" : "オフライン・同期待ち");
    scheduleFlush();
  }

  function getInviteUrl() {
    if (!metadata.inviteToken) return "";
    const base = `${location.origin}${location.pathname}`;
    return `${base}#invite=${metadata.inviteToken}`;
  }

  async function clearConflicts() {
    metadata.conflicts = [];
    await saveMetadata();
    emit(metadata.pending ? "pending" : metadata.householdId ? "synced" : "local", metadata.pending ? "同期待ち…" : metadata.householdId ? "家族と同期済み" : "端末内に保存済み");
  }

  async function reloadFromCloud() {
    if (!metadata.householdId || !navigator.onLine) throw new Error("オンラインで再読込みしてください");
    client ||= await getSupabaseClient();
    emit("syncing", "家族データを再読込み中…");
    const remote = await readRemote();
    await applyState(clone(remote.state));
    await acceptSynced(remote.state, remote.revision);
  }

  addEventListener("online", () => {
    if (!client && (metadata.householdId || inviteTokenFromLocation())) initialize();
    else flush().then(pull);
  });

  return {
    initialize,
    joinFamily,
    queue,
    pull,
    flush,
    startFamily,
    clearConflicts,
    reloadFromCloud,
    isConnected: () => Boolean(metadata.householdId),
    getSnapshot: () => ({ ...metadata, inviteUrl: getInviteUrl() })
  };
}
