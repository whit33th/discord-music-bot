import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder().setName('user').setDescription('Provides information about the user.');

export async function execute({
    interaction,
}: {
    interaction: {
        reply: (value: string) => Promise<unknown>;
        user: { username: string };
        member: { joinedAt: Date | null };
    };
}) {
    await interaction.reply(
        `This command was run by ${interaction.user.username}, who joined on ${interaction.member.joinedAt}.`,
    );
}
