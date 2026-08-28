export function inviteTokenFromLocation(locationObject = globalThis.location) {
  const hash = locationObject?.hash?.startsWith("#") ? locationObject.hash.slice(1) : "";
  return new URLSearchParams(hash).get("invite") || "";
}

export function clearInviteFromAddress() {
  if (!globalThis.history?.replaceState || !globalThis.location) return;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export async function ensureAnonymousSession(client) {
  const { data: current, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (current.session) return current.session;
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  if (!data.session) throw new Error("匿名セッションを開始できません");
  return data.session;
}

export async function joinWithInvite(client, token) {
  await ensureAnonymousSession(client);
  const { data, error } = await client.rpc("join_household", { p_invite_token: token });
  if (error) throw error;
  const joined = data?.[0];
  if (!joined?.household_id) throw new Error("招待先の家族データを確認できません");
  return joined;
}

export async function findCurrentHousehold(client) {
  const { data: current } = await client.auth.getSession();
  if (!current.session) return null;
  const { data, error } = await client.rpc("get_my_household");
  if (error) throw error;
  return data?.[0] || null;
}

export function createInviteToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createHousehold(client, initialState, name = "べぬ家族") {
  await ensureAnonymousSession(client);
  const token = createInviteToken();
  const { data, error } = await client.rpc("create_household", {
    p_name: name,
    p_invite_token: token,
    p_initial_state: initialState
  });
  if (error) throw error;
  const created = data?.[0];
  if (!created?.household_id) throw new Error("家族データを作成できません");
  return { ...created, token };
}

