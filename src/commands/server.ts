import {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { hasAccess } from '../services/authorization.js';
import { runServerBootstrap } from '../services/serverBootstrapRunner.js';

// Guild ids with an in-flight `apply` run. A plain in-process Set is
// sufficient (and never persisted) -- this only guards against two
// concurrent invocations racing within this one bot process, which is what
// could otherwise let both observe the same absent resource and each
// create a duplicate before either's managed_resources insert lands.
const guildsRunningApply = new Set<string>();

export const serverCommand = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Manage the canonical YSL server scaffold.')
  .setDMPermission(false)
  .addSubcommandGroup((group) =>
    group
      .setName('bootstrap')
      .setDescription('Create or reconcile the server scaffold (roles, categories, channels).')
      .addSubcommand((subcommand) =>
        subcommand.setName('plan').setDescription('Preview scaffold changes without applying them.'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('apply')
          .setDescription('Create/reconcile the scaffold for real.')
          .addBooleanOption((option) =>
            option
              .setName('delete_obsolete')
              .setDescription('Also delete managed resources no longer in the template (previewed first).')
              .setRequired(false),
          ),
      ),
  );

// Same runServerBootstrap() the standalone `npm run guild:plan`/`guild:apply`
// script (scripts/bootstrap-guild.ts) uses -- this command exists so the
// server scaffold can be (re)applied from Discord itself, without needing
// local machine/repo access, on a guild the bot is already running in.
export async function handleServerCommand(interaction: ChatInputCommandInteraction, db: Database.Database) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  // On a genuinely fresh server, the ADMIN policy's Allfather/Aesir roles
  // don't exist yet -- runServerBootstrap is what creates them. Nobody
  // could ever pass the ordinary ADMIN check to run the one command that
  // creates the roles the ADMIN check depends on, so this command alone
  // also accepts Discord's own native Administrator permission as a
  // bootstrapping trust path. This is deliberately narrow: it does not
  // touch requireAccess/hasAccess/AccessPolicy, and every other command
  // remains gated strictly by the configured role ids.
  const canBootstrap = member.permissions.has(PermissionFlagsBits.Administrator) || hasAccess(member, 'ADMIN');
  if (!canBootstrap) {
    await interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.options.getSubcommandGroup() !== 'bootstrap') return;

  const apply = interaction.options.getSubcommand() === 'apply';
  const deleteObsolete = apply ? (interaction.options.getBoolean('delete_obsolete') ?? false) : false;

  // Deferred before the lock is touched: if deferReply itself throws (a
  // transient API failure, an expired interaction), nothing needs cleanup
  // and the error just propagates to index.ts's top-level handler, same as
  // any other command. Acquiring the lock first and deferring second would
  // instead leak the lock forever on that failure path.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (apply) {
    if (guildsRunningApply.has(interaction.guild.id)) {
      await interaction.editReply(
        'A server bootstrap apply is already running for this server. Wait for it to finish before starting another.',
      );
      return;
    }
    guildsRunningApply.add(interaction.guild.id);
  }

  const lines: string[] = [];
  let errorMessage: string | undefined;
  try {
    await runServerBootstrap(db, interaction.guild, { apply, deleteObsolete }, (line) => lines.push(line));
  } catch (error) {
    errorMessage = (error as Error).message;
  } finally {
    if (apply) guildsRunningApply.delete(interaction.guild.id);
  }

  // The full log easily exceeds Discord's 2000-character message limit, so
  // it goes out as an attachment; the reply content is just a short summary
  // pointing at it.
  const attachment = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf-8'), {
    name: 'server-bootstrap-log.txt',
  });

  const summary = errorMessage
    ? `Server bootstrap ${apply ? 'apply' : 'plan'} stopped early: ${errorMessage}\nSee the attached log for what happened before the error.`
    : `Server bootstrap ${apply ? 'apply' : 'plan'} complete. See the attached log for details.`;

  await interaction.editReply({ content: summary, files: [attachment] });
}
