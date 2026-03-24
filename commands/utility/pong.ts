import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong!');

export async function execute({ client, interaction }: { client: Client; interaction: ChatInputCommandInteraction }) {
    const ping = client.ws.ping;

    await interaction.reply(`Pong! ${interaction.user.username} - ${ping}ms`);
}
