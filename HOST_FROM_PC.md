# Host the Relay From Your PC

This lets friends join your public room without Render. Your PC runs the relay, and friends connect to your PC.

## Start the relay

In this project folder:

```powershell
npm run relay
```

Leave that PowerShell window open while people are playing.

## Test on your own PC

Use this Relay URL in PolyTrack:

```text
ws://127.0.0.1:8080
```

Click **Public Room**. If you get a 6-character code, the relay is working.

## Same Wi-Fi

The relay prints one or more same-Wi-Fi URLs, like:

```text
ws://192.168.1.50:8080
```

Friends on your same Wi-Fi should use that URL in the Relay URL box.

## Different Wi-Fi

For friends at another house, you need port forwarding:

1. Open your router settings.
2. Port-forward **TCP 8080** to your PC's local IPv4 address.
3. Allow Node.js through Windows Firewall if Windows asks.
4. Find your public IP address.
5. Friends use this Relay URL:

```text
ws://YOUR-PUBLIC-IP:8080
```

Then you click **Public Room** and share the 6-character room code.

## Important notes

- Your PC must stay on.
- The PowerShell relay window must stay open.
- Your public IP can change.
- Some internet providers use CGNAT, which can block port forwarding. If port forwarding does not work, use Tailscale, ZeroTier, ngrok, or a cloud relay.
