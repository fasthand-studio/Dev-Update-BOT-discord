import { supabase } from "./supabase.js";
import { sendDiscordWebhook } from "./discord.js";
import { formatIssueEmbed, formatPREmbed, formatPushEmbed, formatReleaseEmbed } from "./format.js";
import { env } from "./env.js";
import { syncInstallationsAndRepositories, upsertContributor, upsertRepositoryFromPayload } from "./github.js";

type Ctx = { deliveryId: string; event: string; payload: any };

export async function handleGitHubEvent(ctx: Ctx): Promise<{ handled: string; notified?: boolean }> {
  const { event, payload, deliveryId } = ctx;
  const installationId = payload?.installation?.id ?? null;

  if (event === "ping") return { handled: "ping" };

  // Keep repository catalog fresh when installation/repo access changes.
  if (event === "installation" || event === "installation_repositories" || event === "repository") {
    await syncInstallationsAndRepositories().catch(() => null);
  }

  const repoRow = await upsertRepositoryFromPayload(payload?.repository, installationId);
  const actorUser = payload?.sender ?? payload?.pusher;
  const actor = await upsertContributor(actorUser);

  if (event === "push") return handlePush(ctx, repoRow, actor);
  if (event === "pull_request") return handlePullRequest(ctx, repoRow, actor);
  if (event === "release") return handleRelease(ctx, repoRow, actor);
  if (event === "issues") return handleIssues(ctx, repoRow, actor);

  // Track other events for stats/history without noisy notifications.
  await insertActivity({
    event_type: event,
    action: payload?.action ?? null,
    delivery_id: deliveryId,
    repository_id: repoRow?.id ?? null,
    repo_full_name: repoRow?.full_name ?? payload?.repository?.full_name ?? null,
    contributor_id: actor?.id ?? null,
    actor_login: actor?.login ?? payload?.sender?.login ?? null,
    url: payload?.repository?.html_url ?? null,
    title: payload?.action ? `${event}:${payload.action}` : event,
    summary: "Tracked event",
    payload,
    occurred_at: new Date().toISOString(),
  });
  return { handled: event };
}

async function insertActivity(row: any) {
  const { error } = await supabase.from("activity_events").insert(row);
  if (error && error.code !== "23505") throw error;
}

async function notify(embed: any, eventId?: number | null) {
  try {
    await sendDiscordWebhook(env.DISCORD_UPDATES_WEBHOOK_URL, { embeds: [embed] });
    if (eventId) await supabase.from("activity_events").update({ notified_at: new Date().toISOString() }).eq("id", eventId);
  } catch (e: any) {
    if (eventId) await supabase.from("activity_events").update({ notify_error: String(e?.message ?? e).slice(0, 500) }).eq("id", eventId);
    throw e;
  }
}

async function handlePush({ payload, deliveryId }: Ctx, repoRow: any, actor: any) {
  const commits = Array.isArray(payload?.commits) ? payload.commits : [];
  // Ignore branch deletions / empty pushes with no commits? GitHub sends commits array; deletions have after=000...
  if (payload?.deleted && commits.length === 0) return { handled: "push(deleted)" };

  const branch = String(payload?.ref ?? "").replace("refs/heads/", "");
  const pusher = payload?.pusher?.name || payload?.sender?.login || "unknown";
  const { data: ev } = await supabase.from("activity_events").insert({
    event_type: "push",
    action: payload?.created ? "created" : payload?.deleted ? "deleted" : "pushed",
    delivery_id: deliveryId,
    repository_id: repoRow?.id ?? null,
    repo_full_name: repoRow?.full_name ?? payload?.repository?.full_name ?? null,
    contributor_id: actor?.id ?? null,
    actor_login: payload?.sender?.login ?? null,
    ref: payload?.ref ?? null,
    branch,
    commit_count: commits.length,
    url: payload?.compare ?? repoRow?.html_url ?? null,
    title: `Push to ${repoRow?.full_name ?? "repository"}`,
    summary: `${commits.length} commit(s)`,
    payload,
    occurred_at: payload?.head_commit?.timestamp ?? new Date().toISOString(),
  }).select("id").single();

  for (const c of commits) {
    if (!c?.id || !repoRow?.id) continue;
    await supabase.from("commits").upsert({
      repository_id: repoRow.id,
      sha: c.id,
      message: c.message ?? null,
      author_login: c.author?.username ?? null,
      author_name: c.author?.name ?? null,
      author_email: c.author?.email ?? null,
      committer_login: c.committer?.username ?? null,
      url: c.url ?? null,
      branch,
      occurred_at: c.timestamp ?? null,
      push_event_id: ev?.id ?? null,
    }, { onConflict: "repository_id,sha" });
  }

  if (commits.length > 0) {
    await notify(formatPushEmbed({
      repoFullName: repoRow?.full_name ?? payload?.repository?.full_name ?? "repository",
      repoUrl: repoRow?.html_url,
      pusher,
      branch,
      compareUrl: payload?.compare,
      commits: commits.map((c: any) => ({ sha: c.id, message: c.message ?? "", author: c.author?.username || c.author?.name || "unknown", url: c.url })),
    }), ev?.id);
  }
  return { handled: "push", notified: commits.length > 0 };
}

async function handlePullRequest({ payload, deliveryId }: Ctx, repoRow: any, actor: any) {
  const pr = payload?.pull_request;
  if (!pr) return { handled: "pull_request(noop)" };
  const action = payload?.action ?? "updated";
  const important = new Set(["opened", "reopened", "closed", "ready_for_review", "converted_to_draft", "synchronize"]);
  if (!important.has(action)) return { handled: `pull_request(${action})` };

  if (repoRow?.id) {
    await supabase.from("pull_request_snapshots").upsert({
      repository_id: repoRow.id,
      pr_number: pr.number,
      github_id: pr.id,
      title: pr.title,
      state: pr.state,
      draft: !!pr.draft,
      merged: !!pr.merged,
      author_login: pr.user?.login ?? null,
      html_url: pr.html_url,
      base_ref: pr.base?.ref ?? null,
      head_ref: pr.head?.ref ?? null,
      created_at_gh: pr.created_at ?? null,
      updated_at_gh: pr.updated_at ?? null,
      closed_at_gh: pr.closed_at ?? null,
      merged_at_gh: pr.merged_at ?? null,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
      changed_files: pr.changed_files ?? null,
    });
  }

  const externalId = `pr:${repoRow?.github_id ?? payload?.repository?.id}:${pr.number}:${action}:${pr.updated_at ?? ""}`;
  const { data: ev } = await supabase.from("activity_events").insert({
    event_type: "pull_request",
    action,
    delivery_id: deliveryId,
    external_id: externalId,
    repository_id: repoRow?.id ?? null,
    repo_full_name: repoRow?.full_name ?? payload?.repository?.full_name ?? null,
    contributor_id: actor?.id ?? null,
    actor_login: payload?.sender?.login ?? null,
    pr_number: pr.number,
    title: pr.title,
    summary: `PR #${pr.number} ${action}`,
    url: pr.html_url,
    payload,
    occurred_at: pr.updated_at ?? new Date().toISOString(),
  }).select("id").single();

  // Notify for core actions; avoid spamming on every synchronize unless desired? Spec says "updated" - include synchronize.
  const notifyActions = new Set(["opened", "reopened", "closed", "ready_for_review", "synchronize"]);
  if (notifyActions.has(action)) {
    await notify(formatPREmbed({
      repoFullName: repoRow?.full_name ?? payload?.repository?.full_name ?? "repository",
      repoUrl: repoRow?.html_url,
      action,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login ?? payload?.sender?.login ?? "unknown",
      base: pr.base?.ref,
      head: pr.head?.ref,
      merged: !!pr.merged,
    }), ev?.id);
  }
  return { handled: "pull_request", notified: notifyActions.has(action) };
}

async function handleRelease({ payload, deliveryId }: Ctx, repoRow: any, actor: any) {
  const rel = payload?.release;
  const action = payload?.action ?? "published";
  if (!rel) return { handled: "release(noop)" };
  if (!["published", "released", "created", "edited", "prereleased"].includes(action)) return { handled: `release(${action})` };

  const externalId = `release:${rel.id}:${action}:${rel.updated_at ?? rel.published_at ?? ""}`;
  const { data: ev } = await supabase.from("activity_events").insert({
    event_type: "release",
    action,
    delivery_id: deliveryId,
    external_id: externalId,
    repository_id: repoRow?.id ?? null,
    repo_full_name: repoRow?.full_name ?? payload?.repository?.full_name ?? null,
    contributor_id: actor?.id ?? null,
    actor_login: payload?.sender?.login ?? null,
    release_tag: rel.tag_name,
    title: rel.name ?? rel.tag_name,
    summary: `Release ${rel.tag_name} ${action}`,
    url: rel.html_url,
    payload,
    occurred_at: rel.published_at ?? rel.created_at ?? new Date().toISOString(),
  }).select("id").single();

  if (["published", "released", "prereleased"].includes(action)) {
    await notify(formatReleaseEmbed({
      repoFullName: repoRow?.full_name ?? payload?.repository?.full_name ?? "repository",
      action,
      tag: rel.tag_name,
      name: rel.name,
      url: rel.html_url,
      author: rel.author?.login ?? payload?.sender?.login ?? "unknown",
      body: rel.body,
      prerelease: !!rel.prerelease,
      draft: !!rel.draft,
    }), ev?.id);
  }
  return { handled: "release", notified: ["published", "released", "prereleased"].includes(action) };
}

async function handleIssues({ payload, deliveryId }: Ctx, repoRow: any, actor: any) {
  const issue = payload?.issue;
  if (!issue || issue.pull_request) return { handled: "issues(pr-or-noop)" }; // PRs also fire issues events sometimes
  const action = payload?.action ?? "updated";
  const important = new Set(["opened", "closed", "reopened"]);
  if (!important.has(action)) return { handled: `issues(${action})` };

  const externalId = `issue:${repoRow?.github_id ?? payload?.repository?.id}:${issue.number}:${action}:${issue.updated_at ?? ""}`;
  const { data: ev } = await supabase.from("activity_events").insert({
    event_type: "issues",
    action,
    delivery_id: deliveryId,
    external_id: externalId,
    repository_id: repoRow?.id ?? null,
    repo_full_name: repoRow?.full_name ?? payload?.repository?.full_name ?? null,
    contributor_id: actor?.id ?? null,
    actor_login: payload?.sender?.login ?? null,
    issue_number: issue.number,
    title: issue.title,
    summary: `Issue #${issue.number} ${action}`,
    url: issue.html_url,
    payload,
    occurred_at: issue.updated_at ?? new Date().toISOString(),
  }).select("id").single();

  // "important repository activity" - issues opened/closed are worth notifying; keep concise.
  if (action === "opened" || action === "closed") {
    await notify(formatIssueEmbed({
      repoFullName: repoRow?.full_name ?? payload?.repository?.full_name ?? "repository",
      action,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      author: issue.user?.login ?? payload?.sender?.login ?? "unknown",
    }), ev?.id);
  }
  return { handled: "issues", notified: action === "opened" || action === "closed" };
}
