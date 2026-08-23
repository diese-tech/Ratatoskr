import {
  AttachmentBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { requireAccess } from '../services/authorization.js';
import { runServerBootstrap } from '../services/serverBootstrapRunner.js';

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
  if (!(await requireAccess(interaction, member, 'ADMIN'))) return;

  if (interaction.options.getSubcommandGroup() !== 'bootstrap') return;

  const apply = interaction.options.getSubcommand() === 'apply';
  const deleteObsolete = apply ? (interaction.options.getBoolean('delete_obsolete') ?? false) : false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const lines: string[] = [];
  let errorMessage: string | undefined;
  try {
    await runServerBootstrap(db, interaction.guild, { apply, deleteObsolete }, (line) => lines.push(line));
  } catch (error) {
    errorMessage = (error as Error).message;
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
