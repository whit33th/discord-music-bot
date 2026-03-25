import 'dotenv/config';
import { ActivityType, Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { DependencyReportGenerator } from 'discord-player';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPlayer } from './player.js';
import { attachPlayerEvents, handlePlaybackInteraction } from './playback.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

declare module 'discord.js' {
    export interface Client {
        commands: Collection<string, any>;
    }
}

const token = process.env.DISCORD_TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const player = await createPlayer(client);
attachPlayerEvents(player);

function getPreferredOpusBackend() {
    const report = DependencyReportGenerator.generate();

    if (report.libopus['@discordjs/opus']) {
        return `@discordjs/opus ${report.libopus['@discordjs/opus']}`;
    }

    if (report.libopus['@evan/opus']) {
        return `@evan/opus ${report.libopus['@evan/opus']}`;
    }

    if (report.libopus['node-opus']) {
        return `node-opus ${report.libopus['node-opus']}`;
    }

    if (report.libopus.opusscript) {
        return `opusscript ${report.libopus.opusscript}`;
    }

    if (report.libopus.mediaplex) {
        return `mediaplex ${report.libopus.mediaplex}`;
    }

    return 'none';
}

function isYoutubeDlEnabled() {
    return (process.env.YOUTUBE_USE_YTDL ?? 'false').toLowerCase() === 'true';
}

function hasYtDlpCookieFile() {
    return Boolean(process.env.YTDLP_COOKIE_FILE);
}

client.once(Events.ClientReady, (readyClient) => {
    readyClient.user.setActivity('/play', { type: ActivityType.Listening });
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    console.log(`[audio] opus backend: ${getPreferredOpusBackend()}`);
    console.log(`[audio] yt-dlp: ${isYoutubeDlEnabled() ? 'enabled' : 'disabled'}`);
    console.log(`[audio] yt-dlp cookies: ${hasYtDlpCookieFile() ? 'configured' : 'not configured'}`);
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
const commandFileExtension = path.extname(__filename) || '.js';

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(commandFileExtension));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = await import(pathToFileURL(filePath).href);

        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        try {
            const handled = await handlePlaybackInteraction(interaction, player);
            if (handled) return;
        } catch (error) {
            console.error(error);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: 'There was an error while handling this interaction.',
                    flags: MessageFlags.Ephemeral,
                }).catch(() => null);
            } else {
                await interaction.reply({
                    content: 'There was an error while handling this interaction.',
                    flags: MessageFlags.Ephemeral,
                }).catch(() => null);
            }

            return;
        }
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute({ client, interaction, player });
    } catch (error) {
        console.error(error);

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: 'There was an error while executing this command!',
                flags: MessageFlags.Ephemeral,
            }).catch(() => null);
        } else {
            await interaction.reply({
                content: 'There was an error while executing this command!',
                flags: MessageFlags.Ephemeral,
            }).catch(() => null);
        }
    }
});

client.login(token);
