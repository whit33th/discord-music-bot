import { GuildMember, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Player } from 'discord-player';

function getMemberVoiceChannel(interaction: ChatInputCommandInteraction) {
    const member = interaction.member instanceof GuildMember
        ? interaction.member
        : null;

    return member?.voice.channel ?? null;
}

function clampVolume(value: number) {
    return Math.max(0, Math.min(200, value));
}

export const data = new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Sets player volume from 0 to 200')
    .addIntegerOption((option) =>
        option
            .setName('value')
            .setDescription('Volume percentage')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(200)
    );

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

    const value = clampVolume(interaction.options.getInteger('value', true));
    const ok = queue.node.setVolume(value);

    if (!ok) {
        await interaction.reply({ content: 'Could not update the volume.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.reply({ content: `Volume set to ${value}%.`, flags: MessageFlags.Ephemeral });
}
