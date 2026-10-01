import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, type Guild } from 'discord.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';

test('transaction announcements enforce the durable reference as the Discord nonce', async () => {
  const sent: Record<string, unknown>[] = [];
  const guild = { id: 'guild' } as unknown as Guild;
  const channel = {
    type: ChannelType.GuildText,
    guild,
    send: async (payload: Record<string, unknown>) => { sent.push(payload); return { id: 'message' }; },
  };
  Object.assign(guild, { channels: { fetch: async () => channel } });
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const reference = 'YSL-TRX-20260930-ABC12345';
  await gateway.announce({
    content: '<@&team-a>',
    allowedRoleIds: ['team-a'],
    title: 'Word Travels the Branches',
    description: 'A move happened.',
    footer: 'Posted by Admin',
  }, reference);
  assert.equal(sent[0]?.nonce, reference);
  assert.equal(sent[0]?.enforceNonce, true);
});
