import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";
import { env } from "./env.js";
import { supabase } from "./supabase.js";

export async function verifyGitHubWebhook(rawBody: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  return verify(env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
}

export function appOctokit(): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    },
  });
}

export async function installationOctokit(installationId: number): Promise<Octokit> {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId,
    },
  });
}

export function normalizeTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      const ms = s.length >= 13 ? n : n * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export async function listTargetInstallations(): Promise<number[]> {
  if (env.GITHUB_INSTALLATION_IDS?.length) return env.GITHUB_INSTALLATION_IDS;
  const app = appOctokit();
  const installations = await app.paginate(app.apps.listInstallations, { per_page: 100 });
  return installations.map((i) => i.id);
}

export async function syncInstallationsAndRepositories(): Promise<{ installations: number; repositories: number }> {
  const app = appOctokit();
  const ids = await listTargetInstallations();
  let repoCount = 0;

  for (const installationId of ids) {
    const { data: installation } = await app.apps.getInstallation({ installation_id: installationId });
    const account = installation.account as any;
    await supabase.from("github_installations").upsert({
      id: installation.id,
      account_login: account?.login ?? account?.slug ?? account?.name ?? "unknown",
      account_type: installation.target_type ?? account?.type ?? "unknown",
      account_id: account?.id ?? null,
      repositories_selection: installation.repository_selection ?? null,
    });

    const octokit = await installationOctokit(installationId);
    const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, { per_page: 100 });
    const seen = new Set<number>();

    for (const repo of repos) {
      seen.add(repo.id);
      repoCount++;
      await supabase.from("repositories").upsert({
        github_id: repo.id,
        installation_id: installationId,
        owner_login: repo.owner.login,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
        archived: repo.archived,
        disabled: repo.disabled ?? false,
        default_branch: repo.default_branch ?? null,
        html_url: repo.html_url,
        description: repo.description ?? null,
        pushed_at: normalizeTimestamp(repo.pushed_at),
        active: true,
      }, { onConflict: "github_id" });
    }

    // Mark repos from this installation that disappeared as inactive (keeps history).
    if (seen.size > 0) {
      const seenList = [...seen];
      await supabase
        .from("repositories")
        .update({ active: false })
        .eq("installation_id", installationId)
        .not("github_id", "in", `(${seenList.join(",")})`);
    }
  }

  return { installations: ids.length, repositories: repoCount };
}

export async function ensureInstallation(installationId: number, payload: any) {
  const account = payload?.installation?.account ?? payload?.organization ?? payload?.repository?.owner ?? {};
  const login = account?.login ?? payload?.repository?.owner?.login ?? `installation-${installationId}`;
  const type = account?.type ?? (payload?.organization ? "Organization" : "User");
  const { error } = await supabase.from("github_installations").upsert({
    id: installationId,
    account_login: String(login),
    account_type: String(type),
    account_id: account?.id ?? null,
  }, { onConflict: "id" });
  if (error) throw error;
}

export async function upsertRepositoryFromPayload(repo: any, installationId?: number | null, payload?: any) {
  if (!repo?.id || !repo?.full_name) return null;
  if (installationId) await ensureInstallation(installationId, payload);
  const [ownerLogin, name] = String(repo.full_name).split("/");
  const { data, error } = await supabase.from("repositories").upsert({
    github_id: repo.id,
    installation_id: installationId ?? null,
    owner_login: repo.owner?.login ?? ownerLogin ?? "unknown",
    name: repo.name ?? name ?? repo.full_name,
    full_name: repo.full_name,
    private: !!repo.private,
    archived: !!repo.archived,
    disabled: !!repo.disabled,
    default_branch: repo.default_branch ?? null,
    html_url: repo.html_url ?? null,
    description: repo.description ?? null,
    pushed_at: normalizeTimestamp(repo.pushed_at),
    active: true,
  }, { onConflict: "github_id" }).select("id, full_name, html_url, installation_id").single();
  if (error) throw error;
  return data as { id: number; full_name: string; html_url: string | null; installation_id: number | null };
}

export async function upsertContributor(user: any) {
  if (!user?.login) return null;
  const { data, error } = await supabase.from("contributors").upsert({
    github_id: user.id ?? null,
    login: user.login,
    name: user.name ?? null,
    email: user.email ?? null,
    avatar_url: user.avatar_url ?? null,
    html_url: user.html_url ?? null,
    type: user.type ?? null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "login" }).select("id, login").single();
  if (error) throw error;
  return data as { id: number; login: string };
}
