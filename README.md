# Discord Music Bot

A small and friendly Discord music bot — search, playback, sound effects, autoplay and favorites. Designed for a smooth and (fr) catchy UX.

The project is built with TypeScript, `discord.js`, and `discord-player`.

## Features

- play tracks and playlists
- playback controls
- save favorites
- volume control
- effect (8D, Bass, Nightcore)
- slash command support
- lyrics search (may be incomplete, as results are sourced from YouTube)
- autoplay

## Commands

- `/play` - find a track and start it
- `/skip` - skip the current track
- `/stop` - stop playback and clear the queue
- `/leave` - disconnect the bot from the voice channel
- `/volume` - change the volume

## Run

1. Install dependencies:

```bash
bun install
```

2. Create a `.env` file and set at least:

```env
DISCORD_TOKEN=your_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_server_id_here
```

If you want to deploy commands to a specific server, add `GUILD_ID`.

3. Start the bot:

```bash
bun run start
```

To refresh slash commands:

```bash
bun run deploy
```

## Notes

- You need a create bot from the Discord Developer Portal and permission named 'Bot'.
- Source support and streaming quality depend on the available extractors and your YouTube/Spotify settings in `.env`.
