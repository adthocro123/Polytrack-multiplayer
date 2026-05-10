const { networkInterfaces } = require("os");
const { WebSocketServer } = require("ws");

class MultiplayerHost {
	constructor() {
		this.server = null;
		this.port = null;
		this.clients = new Set();
		this.clientIds = new Map();
		this.nextClientId = 1;
	}

	getInfo() {
		const addresses = this.getAddresses();
		return {
			running: null != this.server,
			port: this.port,
			addresses,
			urls: null == this.port ? [] : addresses.map((address) => `ws://${address}:${this.port}`),
		};
	}

	getAddresses() {
		const interfaces = networkInterfaces();
		const addresses = new Set(["127.0.0.1"]);

		Object.values(interfaces).forEach((entries) => {
			(entries || []).forEach((entry) => {
				if (entry && "IPv4" === entry.family && !entry.internal) {
					addresses.add(entry.address);
				}
			});
		});

		return Array.from(addresses);
	}

	async start(port = 32323) {
		const normalizedPort = Number(port);
		if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535) {
			throw new Error("Port must be an integer between 1024 and 65535.");
		}

		if (this.server && this.port === normalizedPort) {
			return this.getInfo();
		}

		await this.stop();

		return await new Promise((resolve, reject) => {
			const server = new WebSocketServer({ port: normalizedPort });

			const fail = (error) => {
				try {
					server.close();
				} catch (_error) {
					// Ignore cleanup errors while the server is still starting.
				}
				reject(error);
			};

			server.once("error", fail);
			server.once("listening", () => {
				server.off("error", fail);
				this.server = server;
				this.port = normalizedPort;
				resolve(this.getInfo());
			});

			server.on("connection", (socket) => {
				if (socket._socket && "function" === typeof socket._socket.setNoDelay) {
					socket._socket.setNoDelay(true);
				}
				this.clients.add(socket);
				this.clientIds.set(socket, `host-${this.nextClientId++}`);
				this.send(socket, { type: "server", event: "welcome", serverPeerId: this.clientIds.get(socket), serverTime: Date.now() });
				this.broadcast({ type: "server", event: "peer-count", peers: this.clients.size - 1 });

				socket.on("message", (buffer) => {
					const payload = "string" === typeof buffer ? buffer : buffer.toString();
					this.relay(socket, payload);
				});

				socket.on("close", () => {
					const serverPeerId = this.clientIds.get(socket);
					this.clients.delete(socket);
					this.clientIds.delete(socket);
					this.broadcast({ type: "server", event: "peer-left", serverPeerId });
					this.broadcast({ type: "server", event: "peer-count", peers: Math.max(0, this.clients.size - 1) });
				});

				socket.on("error", () => {
					// Ignore per-socket errors; the renderer will handle disconnect state.
				});
			});
		});
	}

	send(socket, message) {
		if (1 === socket.readyState) {
			socket.send("string" === typeof message ? message : JSON.stringify(message));
		}
	}

	broadcast(message) {
		const payload = "string" === typeof message ? message : JSON.stringify(message);
		this.clients.forEach((client) => {
			if (1 === client.readyState) {
				client.send(payload);
			}
		});
	}

	relay(sender, payload) {
		const parsed = this.parseMessage(payload);
		if (parsed && "race" === parsed.type && "start-request" === parsed.event) {
			const now = Date.now();
			this.broadcast({
				type: "race",
				event: "countdown",
				raceId: parsed.raceId || `${now}`,
				countdownMs: Math.max(1000, Math.min(10000, Number(parsed.countdownMs) || 4000)),
				serverTime: now,
				startAt: now + Math.max(1000, Math.min(10000, Number(parsed.countdownMs) || 4000)),
			});
			return;
		}

		if (parsed && "race" === parsed.type && "rematch-request" === parsed.event) {
			this.broadcast({
				type: "race",
				event: "rematch",
				raceId: parsed.raceId || `${Date.now()}`,
				serverTime: Date.now(),
			});
			return;
		}

		this.clients.forEach((client) => {
			if (client !== sender && 1 === client.readyState) {
				client.send(payload);
			}
		});
	}

	parseMessage(payload) {
		try {
			const parsed = JSON.parse(payload);
			return parsed && "object" === typeof parsed ? parsed : null;
		} catch (_error) {
			return null;
		}
	}

	async stop() {
		if (!this.server) {
			this.clients.clear();
			this.port = null;
			return;
		}

		const server = this.server;
		this.server = null;
		this.port = null;

		this.clients.forEach((client) => {
			try {
				client.close();
			} catch (_error) {
				// Ignore close failures during shutdown.
			}
		});
		this.clients.clear();

		await new Promise((resolve) => {
			server.close(() => resolve());
		});
	}
}

module.exports = { MultiplayerHost };
