import { GuildMember, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Player } from 'discord-player';

function getMemberVoiceChannel(interaction: ChatInputCommandInteraction) {
    const member = interaction.member instanceof GuildMember
        ? interaction.member
        : null;

    return member?.voice.channel ?? null;
}

export const data = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops playback and clears the queue');

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

    if (!queue.currentTrack && queue.size === 0) {
        await interaction.reply({ content: 'There is nothing to stop.', flags: MessageFlags.Ephemeral });
        return;
    }

    queue.node.stop(true);
    await interaction.reply({ content: 'Stopped playback and cleared the queue.', flags: MessageFlags.Ephemeral });
}
