/**
 * Registers Discord slash commands globally.
 * Usage:
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npx tsx scripts/register-discord-commands.ts
 *
 * Global commands can take up to an hour to propagate. For faster iteration, register guild commands by
 * setting DISCORD_GUILD_ID and changing the endpoint to /applications/{app}/guilds/{guild}/commands.
 */

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");
  process.exit(1);
}

const commands = [
  {
    name: "stats",
    description: "Show development activity statistics",
    options: [{ name: "days", description: "Lookback window in days (default 7)", type: 4, required: false, min_value: 1, max_value: 90 }],
  },
  {
    name: "contributors",
    description: "Show top contributors by commits",
    options: [{ name: "days", description: "Lookback window in days (default 7)", type: 4, required: false, min_value: 1, max_value: 90 }],
  },
  { name: "repositories", description: "List tracked repositories" },
  { name: "weekly", description: "Show the latest weekly development report" },
  {
    name: "repo",
    description: "Show recent activity for a tracked repository",
    options: [
      { name: "name", description: "Repository name or owner/repo", type: 3, required: true },
      { name: "days", description: "Lookback window in days (default 7)", type: 4, required: false, min_value: 1, max_value: 90 },
    ],
  },
];

const base = "https://discord.com/api/v10";
const url = guildId
  ? `${base}/applications/${appId}/guilds/${guildId}/commands`
  : `${base}/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Failed (${res.status}): ${text}`);
  process.exit(1);
}
console.log(`Registered ${commands.length} command(s) to ${guildId ? `guild ${guildId}` : "global scope"}.`);
console.log(text);
