import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const todayInTokyo = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
};

async function ensureDailySessions(supabase: ReturnType<typeof createClient>) {
  const localDate = todayInTokyo();
  const { data: settingsRows, error: settingsError } = await supabase.from("eye_drop_settings").select("*");
  if (settingsError) throw settingsError;
  for (const settings of settingsRows || []) {
    const names = new Map((settings.drop_types || []).map((item: { id: string; name: string }) => [item.id, item.name]));
    for (const template of settings.templates || []) {
      if (!(template.steps || []).length) continue;
      const scheduledAt = new Date(`${localDate}T${template.time}:00+09:00`).toISOString();
      const { data: insertedSession, error: insertError } = await supabase.from("eye_drop_sessions").upsert({
        household_id: settings.household_id,
        local_date: localDate,
        scheduled_time: template.time,
        scheduled_at: scheduledAt,
        interval_seconds: settings.interval_seconds
      }, { onConflict: "household_id,local_date,scheduled_time", ignoreDuplicates: true }).select("id").maybeSingle();
      if (insertError) throw insertError;
      let session = insertedSession;
      if (!session) {
        const { data, error: sessionError } = await supabase.from("eye_drop_sessions").select("id")
          .eq("household_id", settings.household_id).eq("local_date", localDate)
          .eq("scheduled_time", template.time).single();
        if (sessionError) throw sessionError;
        session = data;
      }
      if (!session) throw new Error("eye-drop session was not created");
      if (insertedSession) {
        const steps = (template.steps || []).map((id: string, index: number) => ({
          session_id: session.id,
          drop_type_id: id,
          drop_name: names.get(id) || id,
          step_order: index + 1
        }));
        const { error: stepError } = await supabase.from("eye_drop_steps").insert(steps);
        if (stepError) throw stepError;
      } else {
        const { count, error: countError } = await supabase.from("eye_drop_steps")
          .select("id", { count: "exact", head: true }).eq("session_id", session.id);
        if (countError) throw countError;
        if (!count) continue;
      }
      const { error: jobError } = await supabase.from("notification_jobs").upsert({
        household_id: settings.household_id,
        job_type: "eye_drop_session_start",
        related_session_id: session.id,
        due_at: scheduledAt,
        dedupe_key: `eye-session:${session.id}:start`,
        payload: { title: `${template.time}の点眼時間です`, sessionId: session.id }
      }, { onConflict: "dedupe_key", ignoreDuplicates: true });
      if (jobError) throw jobError;
    }
  }
}

Deno.serve(async (request) => {
  try {
    const cronSecret = required("CRON_SECRET");
    if (request.headers.get("x-cron-secret") !== cronSecret) {
      return new Response("unauthorized", { status: 401 });
    }
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const serverKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || secretKeys.default;
    if (!serverKey) throw new Error("Supabase server secret is not available");
    const supabase = createClient(required("SUPABASE_URL"), serverKey);
    webpush.setVapidDetails(required("VAPID_SUBJECT"), required("VAPID_PUBLIC_KEY"), required("VAPID_PRIVATE_KEY"));
    await ensureDailySessions(supabase);

    const { data: jobs, error: jobsError } = await supabase
      .from("notification_jobs")
      .select("*")
      .is("sent_at", null)
      .is("cancelled_at", null)
      .lte("due_at", new Date().toISOString())
      .order("due_at")
      .limit(100);
    if (jobsError) throw jobsError;

    let delivered = 0;
    for (const job of jobs || []) {
      let userIds: string[] = [];
      if (job.target_user_id) userIds = [job.target_user_id];
      else {
        const { data: members, error } = await supabase.from("household_members")
          .select("user_id").eq("household_id", job.household_id);
        if (error) throw error;
        userIds = (members || []).map((member) => member.user_id);
      }

      if (userIds.length) {
        const { data: preferences, error: preferenceError } = await supabase
          .from("notification_preferences").select("*").in("user_id", userIds);
        if (preferenceError) throw preferenceError;
        const allowed = (preferences || []).filter((preference) => preference.master_enabled
          && (job.job_type === "eye_drop_session_start"
            ? preference.scheduled_eye_drop_enabled
            : preference.active_eye_drop_timer_enabled)).map((preference) => preference.user_id);
        if (allowed.length) {
          const { data: subscriptions, error: subscriptionError } = await supabase
            .from("push_subscriptions").select("*").in("user_id", allowed).eq("enabled", true);
          if (subscriptionError) throw subscriptionError;
          for (const subscription of subscriptions || []) {
            try {
              await webpush.sendNotification({
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth }
              }, JSON.stringify({
                title: job.payload?.title || "べぬケアごはん",
                body: job.payload?.body || "点眼の予定を確認してください。",
                url: `./?eyeSession=${job.related_session_id || ""}`,
                tag: job.dedupe_key
              }));
              delivered += 1;
            } catch (error) {
              const statusCode = error && typeof error === "object" && "statusCode" in error
                ? Number(error.statusCode)
                : 0;
              if (statusCode === 404 || statusCode === 410) {
                await supabase.from("push_subscriptions").update({ enabled: false }).eq("id", subscription.id);
              } else throw error;
            }
          }
        }
      }
      await supabase.from("notification_jobs").update({ sent_at: new Date().toISOString() }).eq("id", job.id);
    }
    return Response.json({ processed: jobs?.length || 0, delivered });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
