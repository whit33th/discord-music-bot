import { GuildMember, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Player } from 'discord-player';
import { getPlaybackErrorMessage, playTrack } from '../../playback';

export const data = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Finds a track and plays it in your voice channel')
    .addStringOption((opt) =>
        opt
            .setName('query')
            .setDescription('Track name or supported link')
            .setRequired(true)
    );

export async function execute({ interaction, player }: { interaction: ChatInputCommandInteraction; player: Player }) {
    if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
        return;
    }

    const member = interaction.member instanceof GuildMember
        ? interaction.member
        : await interaction.guild.members.fetch(interaction.user.id);
    const query = interaction.options.getString('query', true).trim();

    if (!query) {
        await interaction.reply({ content: 'Provide a track name.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply();

    try {
        const result = await playTrack({
            player,
            member,
            query,
            textChannel: interaction.channel!,
            requestedBy: interaction.user,
        });

        const action = result.wasPlaying ? 'Queued' : 'Starting';
        const details = result.playlistTitle ? `playlist **${result.playlistTitle}**` : `**${result.track.title}**`;

        await interaction.editReply(`${action}: ${details}`);
    } catch (error) {
        await interaction.editReply(getPlaybackErrorMessage(error));
    }
}
