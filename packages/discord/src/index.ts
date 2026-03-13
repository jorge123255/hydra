// Discord channel adapter for Hydra.
// Based on Kimaki's discord bot, adapted to implement @hydra/core's Channel interface.
// Key difference: session/OpenCode management stays in @hydra/gateway; 
// this package only handles Discord I/O.

export { DiscordChannel } from "./discord-channel.js";
