// Read-only inspection of a hand-made league division (#196). Nothing is written to Discord or Google.
//   railway run npx tsx scripts/inspect-league-division.ts --division=Niflheim
// Optional: --parent=Svartalfheim (the division its players are layered on), --json (raw report).
//
// Discord is read with REST GET requests only. The script never logs in to the Gateway, so the running
// bot is unaffected. Its whole-guild member listing is a one-off offline read, deliberately outside the
// bot's shared member-read coordinator (ADR 0001 governs the running bot). Never import this from bot code.
import 'dotenv/config';
import { REST } from 'discord.js';
import { GoogleAuth } from 'google-auth-library';
import {
  inspectDivision, readDivisionDiscordState, renderInspectionReport, type ReadOnlyRest, type Rows,
} from '../src/services/divisionInspection.js';

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Run this with the bot's environment, for example through "railway run".`);
  return value;
};
const base = 'https://sheets.googleapis.com/v4/spreadsheets';
type Sheets = { titles(spreadsheetId: string): Promise<string[]>; read(spreadsheetId: string, ranges: string[]): Promise<Rows[]> };

function sheetsReader(): Sheets {
  let credentials: object;
  try { credentials = JSON.parse(required('GOOGLE_SERVICE_ACCOUNT_JSON')); }
  catch (error) {
    if (error instanceof Error && error.message.includes('is not set')) throw error;
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid JSON.');
  }
  // Read-only scope: this script cannot change a spreadsheet even by mistake.
  const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  async function get<T>(url: string): Promise<T> {
    const client = await auth.getClient();
    return (await client.request<T>({ url, method: 'GET', retry: false })).data;
  }
  return {
    titles: async spreadsheetId => (await get<{ sheets: Array<{ properties: { title: string } }> }>(
      `${base}/${spreadsheetId}?fields=sheets(properties(title))`)).sheets.map(sheet => sheet.properties.title),
    read: async (spreadsheetId, ranges) => {
      const query = new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE' });
      for (const range of ranges) query.append('ranges', range);
      const data = await get<{ valueRanges: Array<{ values?: Rows }> }>(`${base}/${spreadsheetId}/values:batchGet?${query}`);
      return data.valueRanges.map(range => range.values ?? []);
    },
  };
}

async function main() {
  const division = (arg('division') ?? '').trim();
  const parentDivision = (arg('parent') ?? 'Svartalfheim').trim();
  if (!/^[A-Z][A-Za-z]+$/.test(division)) throw new Error('Pass the division name, for example --division=Niflheim.');
  const guildId = required('DISCORD_GUILD_ID');
  const adminId = required('YSL_ADMIN_SPREADSHEET_ID');
  const publicId = required('YSL_PUBLIC_SPREADSHEET_ID');
  const token = required('DISCORD_TOKEN');
  const { titles, read } = sheetsReader();

  const [adminTitles, publicTitles] = await Promise.all([titles(adminId), titles(publicId)]);
  for (const title of ['League Teams', 'Player Name History', 'Current Rosters', 'Member Directory'])
    if (!adminTitles.includes(title)) throw new Error(`The Admin workbook has no "${title}" tab. Check YSL_ADMIN_SPREADSHEET_ID.`);
  const [teams, names, rosters, memberDirectory] = await read(adminId,
    ["'League Teams'!A6:L", "'Player Name History'!A6:K", "'Current Rosters'!A6:J", "'Member Directory'!A6:D"]);
  const draftTitle = `${division} Draft`;
  const draft = publicTitles.includes(draftTitle) ? (await read(publicId, [`'${draftTitle}'!A1:O60`]))[0] : undefined;

  const rest = new REST({ version: '10' }).setToken(token);
  // Expose only `get`, so no other request method is reachable from the inspection.
  const readOnly: ReadOnlyRest = { get: (route, options) => rest.get(route, options) };
  const discord = await readDivisionDiscordState(readOnly, guildId);

  const report = inspectDivision({
    division, parentDivision, discord,
    sheets: { adminTitles, publicTitles, teams: teams!, names: names!, rosters: rosters!, memberDirectory: memberDirectory!, ...(draft ? { draft } : {}) },
    ...(process.env.ROLE_NIFLHEIM_FREE_AGENT_ID ? { legacyNiflheimRoleId: process.env.ROLE_NIFLHEIM_FREE_AGENT_ID } : {}),
  });
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : renderInspectionReport(report));
}

main().catch((error: unknown) => {
  console.error(`Inspection stopped. Nothing was changed. ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
