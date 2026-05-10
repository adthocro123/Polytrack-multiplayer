# PolyTrack Public Relay

The app now supports public relay rooms in addition to LAN/direct rooms.

## Run Locally

```bash
npm run relay
```

The default relay URL is:

```text
ws://127.0.0.1:8080
```

## Host Publicly

Deploy `server/public-relay.js` anywhere that supports Node.js WebSockets. Set the app's relay URL to your deployed WebSocket URL, for example:

```text
wss://your-polytrack-relay.example.com
```

Players can then create a public room, share the six-character code, and join without port forwarding.

## Notes

- The relay passes packets between players; it does not simulate cars.
- The room host controls countdowns, presets, track sync, and kicks.
- Use `wss://` for public HTTPS deployments.
