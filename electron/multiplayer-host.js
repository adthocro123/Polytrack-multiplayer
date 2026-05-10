const { networkInterfaces } = require("os");
const { WebSocketServer } = require("ws");

class MultiplayerHost {
	constructor() {
		this.server = null;
		this.port = null;
		this.clients = new Set();
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
				this.broadcast({ type: "server", event: "peer-count", peers: this.clients.size - 1 });

				socket.on("message", (buffer) => {
					const payload = "string" === typeof buffer ? buffer : buffer.toString();
					this.relay(socket, payload);
				});

				socket.on("close", () => {
					this.clients.delete(socket);
					this.broadcast({ type: "server", event: "peer-count", peers: Math.max(0, this.clients.size - 1) });
				});

				socket.on("error", () => {
					// Ignore per-socket errors; the renderer will handle disconnect state.
				});
			});
		});
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
		this.clients.forEach((client) => {
			if (client !== sender && 1 === client.readyState) {
				client.send(payload);
			}
		});
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
