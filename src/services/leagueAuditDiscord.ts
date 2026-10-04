import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { getValidatedStaffChannel } from './operationalErrors.js';
import type { LeagueAuditCardPort } from './leagueAudit.js';

function nonceFor(reference: string): string {
  return createHash('sha256').update(reference).digest('hex').slice(0, 24);
}

export function createLeagueAuditCardPort(
  client: Client,
  db: Database.Database,
  guildId: string,
): LeagueAuditCardPort {
  return {
    async findByReference(reference) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      const bot = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory)) {
        throw new Error('bot cannot read staff-ops history for league audit recovery');
      }
      const expectedNonce = nonceFor(reference);
      let before: string | undefined;
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        const match = messages.find((message) => message.author.id === client.user?.id
          && String(message.nonce ?? '') === expectedNonce);
        if (match) return match.id;
        if (messages.size < 100) return undefined;
        const oldest = messages.last();
        if (!oldest || oldest.id === before) return undefined;
        before = oldest.id;
      }
    },
    async send(card, reference) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      const message = await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle(card.title)
          .setDescription(card.description.slice(0, 4096))
          .setFooter({ text: card.footer.slice(0, 2048) })
          .setColor(0xC43C35)],
        components: card.actions?.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
          card.actions.map((action) => new ButtonBuilder()
            .setCustomId(`${action.id}:${reference}`)
            .setLabel(action.label)
            .setStyle(ButtonStyle.Primary)),
        )] : [],
        allowedMentions: { parse: [] },
        nonce: nonceFor(reference),
        enforceNonce: true,
      });
      return message.id;
    },
    async delete(messageId) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      try {
        await channel.messages.delete(messageId);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === RESTJSONErrorCodes.UnknownMessage) return;
        throw error;
      }
    },
  };
}
