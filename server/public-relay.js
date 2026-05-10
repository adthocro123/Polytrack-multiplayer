const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rooms = new Map();

const makeRoomCode = () => {
	for (let attempt = 0; attempt < 1000; attempt++) {
		let code = "";
		for (let index = 0; index < 6; index++) {
			code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
		}
		if (!rooms.has(code)) {
			return code;
		}
	}
	throw new Error("Could not allocate a room code.");
};

const send = (socket, message) => {
	if (1 === socket.readyState) {
		socket.send(JSON.stringify(message));
	}
};

const roomPeers = (room) => Math.max(0, room.clients.size - 1);

const broadcast = (room, message, except = null) => {
	const payload = JSON.stringify(message);
	room.clients.forEach((client) => {
		if (client !== except && 1 === client.readyState) {
			client.send(payload);
		}
	});
};

const leaveRoom = (socket) => {
	if (!socket.roomCode) {
		return;
	}
	const room = rooms.get(socket.roomCode);
	if (!room) {
		socket.roomCode = null;
		return;
	}
	room.clients.delete(socket);
	if (room.host === socket) {
		const nextHost = room.clients.values().next().value || null;
		room.host = nextHost;
		if (nextHost) {
			send(nextHost, { type: "room", event: "host", code: socket.roomCode, serverTime: Date.now() });
		}
	}
	if (0 === room.clients.size) {
		rooms.delete(socket.roomCode);
	} else {
		broadcast(room, { type: "room", event: "peer-count", code: socket.roomCode, peers: roomPeers(room), serverTime: Date.now() });
		broadcast(room, { type: "server", event: "peer-left", playerId: socket.playerId || null, serverTime: Date.now() });
	}
	socket.roomCode = null;
};

const joinRoom = (socket, code) => {
	const normalizedCode = String(code || "").trim().toUpperCase();
	const room = rooms.get(normalizedCode);
	if (!room) {
		send(socket, { type: "room", event: "error", message: "Room code not found.", serverTime: Date.now() });
		return;
	}
	leaveRoom(socket);
	socket.roomCode = normalizedCode;
	room.clients.add(socket);
	send(socket, {
		type: "room",
		event: "joined",
		code: normalizedCode,
		isHost: room.host === socket,
		hostPlayerId: room.host ? room.host.playerId || null : null,
		serverTime: Date.now(),
	});
	broadcast(room, { type: "room", event: "peer-count", code: normalizedCode, peers: roomPeers(room), serverTime: Date.now() });
};

const createRoom = (socket) => {
	const code = makeRoomCode();
	leaveRoom(socket);
	const room = { code, host: socket, clients: new Set([socket]) };
	rooms.set(code, room);
	socket.roomCode = code;
	send(socket, { type: "room", event: "created", code, isHost: true, hostPlayerId: socket.playerId || null, serverTime: Date.now() });
};

const relay = (socket, payload) => {
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch (_error) {
		return;
	}

	if (!parsed || "object" !== typeof parsed) {
		return;
	}

	if ("room" === parsed.type && "create" === parsed.event) {
		socket.playerId = parsed.playerId || socket.playerId;
		createRoom(socket);
		return;
	}

	if ("room" === parsed.type && "join" === parsed.event) {
		socket.playerId = parsed.playerId || socket.playerId;
		joinRoom(socket, parsed.code);
		return;
	}

	socket.playerId = parsed.playerId || socket.playerId;
	const room = socket.roomCode ? rooms.get(socket.roomCode) : null;
	if (!room) {
		send(socket, { type: "room", event: "error", message: "Join or create a room first.", serverTime: Date.now() });
		return;
	}

	if ("race" === parsed.type && "start-request" === parsed.event) {
		if (room.host !== socket) {
			send(socket, { type: "room", event: "error", message: "Only the room host can start a race.", serverTime: Date.now() });
			return;
		}
		const now = Date.now();
		const countdownMs = Math.max(1000, Math.min(10000, Number(parsed.countdownMs) || 4000));
		broadcast(room, {
			type: "race",
			event: "countdown",
			raceId: parsed.raceId || `${now}`,
			countdownMs,
			preset: parsed.preset,
			track: parsed.track,
			serverTime: now,
			startAt: now + countdownMs,
		});
		return;
	}

	if ("race" === parsed.type && "rematch-request" === parsed.event) {
		broadcast(room, { type: "race", event: "rematch", raceId: parsed.raceId || `${Date.now()}`, serverTime: Date.now() });
		return;
	}

	broadcast(room, parsed, socket);
};

const server = new WebSocketServer({ port: PORT });

server.on("connection", (socket) => {
	if (socket._socket && "function" === typeof socket._socket.setNoDelay) {
		socket._socket.setNoDelay(true);
	}
	send(socket, { type: "server", event: "welcome", serverTime: Date.now() });
	socket.on("message", (buffer) => {
		relay(socket, "string" === typeof buffer ? buffer : buffer.toString());
	});
	socket.on("close", () => {
		leaveRoom(socket);
	});
	socket.on("error", () => {
		// Per-socket errors are handled by clients reconnecting or leaving.
	});
});

console.log(`PolyTrack public relay listening on ws://0.0.0.0:${PORT}`);
