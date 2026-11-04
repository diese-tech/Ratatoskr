// One-time import of a hand-made layered division (Niflheim, #199) into the league Sheets.
//   Dry run:  railway run npx tsx scripts/import-league-division.ts --division=Niflheim
//   Apply:    ... --write --expect-admin-id=<id> --expect-public-id=<id> --expect-plan=<hash from the dry run>
// Optional:  --accept=<finding-id>[,<finding-id>]  acknowledge a listed blocking finding
//            --link=<new Discord ID>:<earlier Discord ID>  same player on a new account (earlier one must be Inactive)
//
// The import writes Sheets only, never Discord. Discord is read with REST GET requests only (no Gateway
// login), under the approved maintenance-script exception to the shared member-read rule (ADR 0001, #196).
// Never import this from bot code. Run --write only in a staff-approved quiet window: the bot is not
// paused, so the script re-reads every source immediately before writing and stops if anything changed.
import 'dotenv/config';
import { REST } from 'discord.js';
import { GoogleAuth } from 'google-auth-library';
import { LEAGUE_DIVISION_METADATA, isLeagueDivision } from '../src/domain/leagueDivisions.js';
import { describeInspectionFailure, InspectionSetupError, readDivisionDiscordState, type ReadOnlyRest, type Rows } from '../src/services/divisionInspection.js';
import { planDivisionImport, renderImportPlan, type ImportPlan, type ImportSources } from '../src/services/divisionImport.js';

const TEMPLATE_TAB = 'Roster Default (DNE)';
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new InspectionSetupError(`${name} is not set. Run this with the bot's environment, for example through "railway run".`);
  return value;
};
const write = process.argv.includes('--write');
let writing = false;
const base = 'https://sheets.googleapis.com/v4/spreadsheets';
type Meta = { sheets: Array<{ properties: { sheetId: number; title: string } }> };

function sheetsClient() {
  let credentials: object;
  try { credentials = JSON.parse(required('GOOGLE_SERVICE_ACCOUNT_JSON')); }
  catch (error) {
    if (error instanceof InspectionSetupError) throw error;
    throw new InspectionSetupError('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid JSON.');
  }
  // A dry run can only read; only --write asks for permission to change the workbooks.
  const auth = new GoogleAuth({ credentials, scopes: [write ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly'] });
  async function call<T>(url: string, data?: unknown): Promise<T> {
    const client = await auth.getClient();
    return (await client.request<T>({ url, method: data ? 'POST' : 'GET', ...(data ? { data } : {}), retry: false })).data;
  }
  return {
    call,
    meta: (spreadsheetId: string) => call<Meta>(`${base}/${spreadsheetId}?fields=sheets(properties(sheetId,title))`),
    read: async (spreadsheetId: string, ranges: string[]): Promise<Rows[]> => {
      const query = new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE' });
      for (const range of ranges) query.append('ranges', range);
      const data = await call<{ valueRanges: Array<{ values?: Rows }> }>(`${base}/${spreadsheetId}/values:batchGet?${query}`);
      if (data.valueRanges.length !== ranges.length) throw new InspectionSetupError('Google returned an incomplete read. Nothing was changed; run the dry run again.');
      return data.valueRanges.map(range => range.values ?? []);
    },
  };
}

async function main() {
  const division = (arg('division') ?? '').trim();
  if (!isLeagueDivision(division) || !LEAGUE_DIVISION_METADATA[division].layeredOn)
    throw new InspectionSetupError('Pass a layered division, for example --division=Niflheim.');
  const parent = LEAGUE_DIVISION_METADATA[division].layeredOn!;
  const rosterTab = LEAGUE_DIVISION_METADATA[division].publicTab;
  const guildId = required('DISCORD_GUILD_ID');
  const adminId = required('YSL_ADMIN_SPREADSHEET_ID');
  const publicId = required('YSL_PUBLIC_SPREADSHEET_ID');
  if (write && (arg('expect-admin-id') !== adminId || arg('expect-public-id') !== publicId))
    throw new InspectionSetupError('--write needs --expect-admin-id and --expect-public-id that match this environment\'s workbooks. Nothing was changed.');
  const links = Object.fromEntries((arg('link') ?? '').split(',').filter(Boolean).map(pair => {
    const [newId, oldId] = pair.split(':');
    if (!/^\d{16,20}$/.test(newId ?? '') || !/^\d{16,20}$/.test(oldId ?? '')) throw new InspectionSetupError('--link takes <new Discord ID>:<earlier Discord ID>.');
    return [newId!, oldId!];
  }));
  const accepted = (arg('accept') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const sheets = sheetsClient();
  const rest = new REST({ version: '10' }).setToken(required('DISCORD_TOKEN'));
  const readOnly: ReadOnlyRest = { get: (route, options) => rest.get(route, options) };

  async function load(): Promise<{ sources: ImportSources; plan: ImportPlan; publicMeta: Meta }> {
    const [adminMeta, publicMeta] = await Promise.all([sheets.meta(adminId), sheets.meta(publicId)]);
    const adminTitles = adminMeta.sheets.map(sheet => sheet.properties.title);
    const publicTitles = publicMeta.sheets.map(sheet => sheet.properties.title);
    for (const title of ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History'])
      if (!adminTitles.includes(title)) throw new InspectionSetupError(`The Admin workbook has no "${title}" tab. Check YSL_ADMIN_SPREADSHEET_ID. Nothing was changed.`);
    if (!publicTitles.includes(LEAGUE_DIVISION_METADATA[parent].publicTab))
      throw new InspectionSetupError(`The public workbook has no "${LEAGUE_DIVISION_METADATA[parent].publicTab}" tab. Check YSL_PUBLIC_SPREADSHEET_ID. Nothing was changed.`);
    const hasDirectory = adminTitles.includes('Member Directory');
    const [teams, rosters, names, history, memberDirectory] = await sheets.read(adminId, ["'League Teams'!A5:L", "'Current Rosters'!A5:J",
      "'Player Name History'!A5:K", "'Transaction History'!A5:M", ...(hasDirectory ? ["'Member Directory'!A6:D"] : [])]);
    const draftTab = `${division} Draft`;
    const divisionSource = publicTitles.includes(rosterTab) ? rosterTab : TEMPLATE_TAB;
    const publicRanges: Array<[string, string]> = [['parent', `'${LEAGUE_DIVISION_METADATA[parent].publicTab}'!A1:O99`],
      ...(publicTitles.includes(divisionSource) ? [['division', `'${divisionSource}'!A1:O99`] as [string, string]] : []),
      ...(publicTitles.includes(draftTab) ? [['draft', `'${draftTab}'!A1:O60`] as [string, string]] : [])];
    const publicRows = await sheets.read(publicId, publicRanges.map(([, range]) => range));
    const publicRead = new Map(publicRanges.map(([key], index) => [key, publicRows[index]!]));
    const discord = await readDivisionDiscordState(readOnly, guildId);
    const sources: ImportSources = {
      division, date, discord, links, accepted,
      admin: { titles: adminTitles, teams: teams!, rosters: rosters!, names: names!, history: history!, memberDirectory: memberDirectory ?? [] },
      public: { titles: publicTitles, parentRoster: publicRead.get('parent')!, divisionRoster: publicRead.get('division') ?? [],
        ...(publicRead.has('draft') ? { draft: publicRead.get('draft')! } : {}) },
    };
    return { sources, plan: planDivisionImport(sources), publicMeta };
  }

  const { sources, plan, publicMeta } = await load();
  process.stdout.write(renderImportPlan(plan, write));
  const nothingToDo = !plan.adminUpdates.length && !plan.publicUpdates.length && !plan.createRosterTab;
  if (!write || nothingToDo || plan.blocked) {
    if (write && plan.blocked) process.exitCode = 1;
    if (!write && !plan.blocked && !nothingToDo)
      console.log(`\nDry run only. To apply this exact plan, re-run with --write --expect-admin-id=${adminId} --expect-public-id=${publicId} --expect-plan=${plan.hash}`);
    return;
  }
  if (arg('expect-plan') !== plan.hash)
    throw new InspectionSetupError('The sheets or Discord changed since the reviewed dry run (or --expect-plan is missing). Nothing was changed. Run a new dry run and review it.');

  writing = true;
  if (plan.createRosterTab) {
    const template = publicMeta.sheets.find(sheet => sheet.properties.title === TEMPLATE_TAB)!;
    await sheets.call(`${base}/${publicId}:batchUpdate`, { requests: [{ duplicateSheet: { sourceSheetId: template.properties.sheetId, newSheetName: rosterTab } }] });
    const [copy] = await sheets.read(publicId, [`'${rosterTab}'!A1:O99`]);
    if (JSON.stringify(copy) !== JSON.stringify(sources.public.divisionRoster))
      throw new InspectionSetupError(`The new "${rosterTab}" tab does not match the template that was reviewed. Only that empty tab was created; no roster data was written. Delete it, then run a new dry run.`);
  }
  if (plan.adminUpdates.length) await sheets.call(`${base}/${adminId}/values:batchUpdate`, { valueInputOption: 'RAW', data: plan.adminUpdates });
  if (plan.publicUpdates.length) await sheets.call(`${base}/${publicId}/values:batchUpdate`, { valueInputOption: 'RAW', data: plan.publicUpdates });

  const after = await load();
  const leftover = after.plan.adminUpdates.length + after.plan.publicUpdates.length + (after.plan.createRosterTab ? 1 : 0);
  if (leftover || after.plan.blocked) {
    process.exitCode = 1;
    console.log(`\nThe import wrote its changes, but a fresh check does not match the reviewed plan (${leftover} differences, ${after.plan.findings.filter(finding => finding.blocking).length} new problems). Do not run --write again. Ask a maintainer to compare the sheets with the fresh check below.\n`);
    process.stdout.write(renderImportPlan(after.plan, false));
    return;
  }
  console.log(`\nImport complete: ${plan.adminUpdates.length} Admin and ${plan.publicUpdates.length} public cells written, and a fresh check finds nothing left to import. Next: run "Check again" on the League Status card, then fix the listed Discord roles.`);
}

main().catch((error: unknown) => {
  const { message, detail } = describeInspectionFailure(error);
  console.error(`Import stopped. ${message}`);
  if (detail) console.error(`Details for maintainers: ${detail}`);
  console.error(writing ? 'Some changes may already have been written. Do not run --write again; run a dry run and compare it with the sheets first.' : 'Nothing was changed.');
  process.exitCode = 1;
});
