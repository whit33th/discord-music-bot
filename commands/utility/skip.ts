import { GuildMember, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Player } from 'discord-player';

function getMemberVoiceChannel(interaction: ChatInputCommandInteraction) {
    const member = interaction.member instanceof GuildMember
        ? interaction.member
        : null;

    return member?.voice.channel ?? null;
}

export const data = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skips the current track');

export async function execute({ interaction, player }: { interaction: ChatInputCommandInteraction; player: Player }) {
    if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
        return;
    }

    const voiceChannel = getMemberVoiceChannel(interaction);
    if (!voiceChannel) {
        await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
        return;
    }

    const queue = player.nodes.get(interaction.guildId);
    if (!queue?.channel || queue.channel.id !== voiceChannel.id) {
        await interaction.reply({ content: 'You need to be in the same voice channel as the bot.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (!queue.currentTrack) {
        await interaction.reply({ content: 'Nothing is currently playing.', flags: MessageFlags.Ephemeral });
        return;
    }

    queue.node.skip();
    await interaction.reply({ content: 'Skipped the current track.', flags: MessageFlags.Ephemeral });
}
