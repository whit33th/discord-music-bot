import { AppleMusicExtractor, SoundCloudExtractor, SpotifyExtractor } from '@discord-player/extractor';
import { Player } from 'discord-player';
import type { Client } from 'discord.js';
import { YoutubeSabrExtractor } from 'discord-player-googlevideo';

export async function createPlayer(client: Client) {
    const player = new Player(client);

    await player.extractors.register(YoutubeSabrExtractor, {});
    await player.extractors.register(SoundCloudExtractor, {});
    await player.extractors.register(AppleMusicExtractor, {});

    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
        await player.extractors.register(SpotifyExtractor, {
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        });
    }

    return player;
}
