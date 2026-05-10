(() => {
	const DEFAULT_PORT = 32323;
	const SNAPSHOT_INTERVAL_MS = 33;
	const INTERPOLATION_DELAY_MS = 80;
	const MAX_EXTRAPOLATION_MS = 120;
	const MAX_REMOTE_SAMPLES = 12;
	const REMOTE_STALE_MS = 1500;
	const COUNTDOWN_MS = 4000;
	const LEADERBOARD_REFRESH_MS = 120;
	const PLAYER_NAME_KEY = "polytrack.multiplayer.playerName";
	const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

	const createPlayerId = () => `p-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36).slice(-4)}`;
	const loadPlayerName = () => {
		try {
			const savedName = localStorage.getItem(PLAYER_NAME_KEY);
			if (savedName && savedName.trim()) {
				return savedName.trim().slice(0, 24);
			}
		} catch (_error) {
			// Ignore storage failures and fall back to a generated display name.
		}
		return `Player ${Math.floor(100 + 900 * Math.random())}`;
	};

	const state = {
		hooks: null,
		socket: null,
		isHosting: false,
		hostInfo: null,
		playerId: createPlayerId(),
		playerName: loadPlayerName(),
		serverClockOffsetMs: 0,
		lastSnapshotAt: 0,
		remoteSamples: [],
		previousRemoteSample: null,
		lastRenderedRemoteFrame: null,
		players: new Map(),
		localReady: false,
		localFinishSent: false,
		race: {
			phase: "idle",
			raceId: null,
			startAt: 0,
			countdownTimer: null,
			leaderboardTimer: null,
		},
		panelOpen: true,
		dom: {},
	};

	const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

	const cloneState = (value) => {
		if ("function" === typeof structuredClone) {
			return structuredClone(value);
		}
		return JSON.parse(JSON.stringify(value));
	};

	const getServerNow = () => Date.now() + state.serverClockOffsetMs;

	const updateServerClock = (serverTime) => {
		if ("number" === typeof serverTime && Number.isFinite(serverTime)) {
			state.serverClockOffsetMs = serverTime - Date.now();
		}
	};

	const formatRaceTime = (milliseconds) => {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) {
			return "--:--.---";
		}
		const total = Math.floor(milliseconds);
		const minutes = Math.floor(total / 60000);
		const seconds = Math.floor((total - 60000 * minutes) / 1000);
		const millis = total - 60000 * minutes - 1000 * seconds;
		return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
	};

	const formatFrames = (frames) => formatRaceTime("number" === typeof frames ? frames : Number.NaN);

	const parseIPv4 = (value) => {
		const parts = value.split(".").map((part) => Number(part));
		if (4 !== parts.length || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
			return null;
		}
		return parts;
	};

	const encodeRoomCode = (address, port) => {
		const parts = parseIPv4(address);
		const normalizedPort = Number(port);
		if (!parts || !Number.isInteger(normalizedPort) || normalizedPort < 0 || normalizedPort > 65535) {
			return "";
		}
		let value = 0n;
		parts.forEach((part) => {
			value = (value << 8n) + BigInt(part);
		});
		value = (value << 16n) + BigInt(normalizedPort);
		let encoded = "";
		for (let index = 0; index < 10; index++) {
			encoded = ROOM_CODE_ALPHABET[Number(value & 31n)] + encoded;
			value >>= 5n;
		}
		return `${encoded.slice(0, 5)}-${encoded.slice(5)}`;
	};

	const decodeRoomCode = (code) => {
		const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
		if (10 !== cleaned.length) {
			return null;
		}
		let value = 0n;
		for (const character of cleaned) {
			const digit = ROOM_CODE_ALPHABET.indexOf(character);
			if (digit < 0) {
				return null;
			}
			value = (value << 5n) + BigInt(digit);
		}
		const port = Number(value & 65535n);
		value >>= 16n;
		const parts = [];
		for (let index = 0; index < 4; index++) {
			parts.unshift(Number(value & 255n));
			value >>= 8n;
		}
		return `ws://${parts.join(".")}:${port}`;
	};

	const getShareRoomCode = () => {
		if (!state.hostInfo || !state.hostInfo.addresses) {
			return "";
		}
		const address = state.hostInfo.addresses.find((value) => value && "127.0.0.1" !== value) || state.hostInfo.addresses[0];
		return address ? encodeRoomCode(address, state.hostInfo.port) : "";
	};

	const lerp = (from, to, amount) => from + (to - from) * amount;

	const lerpNumberArray = (from, to, amount) => {
		if (!Array.isArray(from) || !Array.isArray(to)) {
			return Array.isArray(to) ? to.slice() : to;
		}
		return to.map((value, index) => "number" === typeof value && "number" === typeof from[index] ? lerp(from[index], value, amount) : value);
	};

	const lerpVector = (from, to, amount) => {
		if (!from || !to) {
			return to;
		}
		return {
			x: lerp(from.x || 0, to.x || 0, amount),
			y: lerp(from.y || 0, to.y || 0, amount),
			z: lerp(from.z || 0, to.z || 0, amount),
		};
	};

	const slerpQuaternion = (from, to, amount) => {
		if (!from || !to) {
			return to;
		}

		let tx = to.x || 0;
		let ty = to.y || 0;
		let tz = to.z || 0;
		let tw = "number" === typeof to.w ? to.w : 1;
		const fx = from.x || 0;
		const fy = from.y || 0;
		const fz = from.z || 0;
		const fw = "number" === typeof from.w ? from.w : 1;
		let dot = fx * tx + fy * ty + fz * tz + fw * tw;

		if (dot < 0) {
			dot = -dot;
			tx = -tx;
			ty = -ty;
			tz = -tz;
			tw = -tw;
		}

		if (dot > 0.9995) {
			const x = lerp(fx, tx, amount);
			const y = lerp(fy, ty, amount);
			const z = lerp(fz, tz, amount);
			const w = lerp(fw, tw, amount);
			const length = Math.hypot(x, y, z, w) || 1;
			return { x: x / length, y: y / length, z: z / length, w: w / length };
		}

		const theta = Math.acos(clamp(dot, -1, 1));
		const sinTheta = Math.sin(theta) || 1;
		const fromScale = Math.sin((1 - amount) * theta) / sinTheta;
		const toScale = Math.sin(amount * theta) / sinTheta;
		return {
			x: fx * fromScale + tx * toScale,
			y: fy * fromScale + ty * toScale,
			z: fz * fromScale + tz * toScale,
			w: fw * fromScale + tw * toScale,
		};
	};

	const blendCarState = (from, to, amount) => {
		const blended = cloneState(to);
		blended.position = lerpVector(from.position, to.position, amount);
		blended.quaternion = slerpQuaternion(from.quaternion, to.quaternion, amount);

		if ("number" === typeof from.speedKmh && "number" === typeof to.speedKmh) {
			blended.speedKmh = lerp(from.speedKmh, to.speedKmh, amount);
		}

		["wheelSuspensionLength", "wheelSuspensionVelocity", "wheelRotation", "wheelDeltaRotation", "wheelSkidInfo"].forEach((key) => {
			blended[key] = lerpNumberArray(from[key], to[key], amount);
		});

		if (Array.isArray(from.wheelPosition) && Array.isArray(to.wheelPosition)) {
			blended.wheelPosition = to.wheelPosition.map((value, index) => lerpVector(from.wheelPosition[index], value, amount));
		}

		if (Array.isArray(from.wheelQuaternion) && Array.isArray(to.wheelQuaternion)) {
			blended.wheelQuaternion = to.wheelQuaternion.map((value, index) => slerpQuaternion(from.wheelQuaternion[index], value, amount));
		}

		if ("number" === typeof to.frames) {
			if (null == state.lastRenderedRemoteFrame) {
				state.lastRenderedRemoteFrame = to.frames;
			} else if (to.frames > state.lastRenderedRemoteFrame) {
				state.lastRenderedRemoteFrame += 1;
			}
			blended.frames = state.lastRenderedRemoteFrame;
		}

		return blended;
	};

	const extrapolateCarState = (fromSample, toSample, elapsedMs) => {
		const sampleDuration = Math.max(1, toSample.receivedAt - fromSample.receivedAt);
		const amount = clamp(elapsedMs / sampleDuration, 0, MAX_EXTRAPOLATION_MS / sampleDuration);
		const predicted = cloneState(toSample.state);

		if (fromSample.state.position && toSample.state.position) {
			predicted.position = {
				x: toSample.state.position.x + (toSample.state.position.x - fromSample.state.position.x) * amount,
				y: toSample.state.position.y + (toSample.state.position.y - fromSample.state.position.y) * amount,
				z: toSample.state.position.z + (toSample.state.position.z - fromSample.state.position.z) * amount,
			};
		}

		["wheelSuspensionLength", "wheelSuspensionVelocity", "wheelRotation", "wheelDeltaRotation"].forEach((key) => {
			if (Array.isArray(fromSample.state[key]) && Array.isArray(toSample.state[key])) {
				predicted[key] = toSample.state[key].map((value, index) => value + (value - fromSample.state[key][index]) * amount);
			}
		});

		if ("number" === typeof predicted.frames) {
			if (null == state.lastRenderedRemoteFrame) {
				state.lastRenderedRemoteFrame = predicted.frames;
			} else {
				state.lastRenderedRemoteFrame += 1;
			}
			predicted.frames = state.lastRenderedRemoteFrame;
		}

		return predicted;
	};

	const resetRemoteSmoothing = () => {
		state.remoteSamples = [];
		state.previousRemoteSample = null;
		state.lastRenderedRemoteFrame = null;
	};

	const pushRemoteSample = (carState) => {
		if (!state.hooks) {
			return;
		}

		const sample = {
			receivedAt: performance.now(),
			state: cloneState(carState),
		};
		state.hooks.lastRemoteState = sample.state;
		state.remoteSamples.push(sample);
		while (state.remoteSamples.length > MAX_REMOTE_SAMPLES) {
			state.previousRemoteSample = state.remoteSamples.shift();
		}

		if ("function" === typeof state.hooks.ensureRemoteCar && state.hooks.ensureRemoteCar() && state.hooks.remoteCar && 1 === state.remoteSamples.length) {
			state.hooks.remoteCar.setCarState(sample.state);
			state.lastRenderedRemoteFrame = "number" === typeof sample.state.frames ? sample.state.frames : null;
		}
	};

	const getSmoothedRemoteState = () => {
		if (!state.remoteSamples.length) {
			return null;
		}

		const now = performance.now();
		const newest = state.remoteSamples[state.remoteSamples.length - 1];
		if (now - newest.receivedAt > REMOTE_STALE_MS) {
			return newest.state;
		}

		const renderAt = now - INTERPOLATION_DELAY_MS;
		while (state.remoteSamples.length >= 2 && state.remoteSamples[1].receivedAt <= renderAt) {
			state.previousRemoteSample = state.remoteSamples.shift();
		}

		if (state.remoteSamples.length >= 2) {
			const from = state.remoteSamples[0];
			const to = state.remoteSamples[1];
			const amount = clamp((renderAt - from.receivedAt) / Math.max(1, to.receivedAt - from.receivedAt), 0, 1);
			return blendCarState(from.state, to.state, amount);
		}

		if (state.previousRemoteSample && renderAt > newest.receivedAt) {
			return extrapolateCarState(state.previousRemoteSample, newest, renderAt - newest.receivedAt);
		}

		return newest.state;
	};

	const renderSmoothedRemoteCar = () => {
		if (!state.hooks || !state.hooks.remoteCar || "function" !== typeof state.hooks.remoteCar.setCarState) {
			return;
		}
		const smoothedState = getSmoothedRemoteState();
		if (smoothedState) {
			state.hooks.remoteCar.setCarState(smoothedState);
		}
	};

	const installRemoteSmoothing = () => {
		if (!state.hooks || state.hooks.__polytrackSmoothingInstalled) {
			return;
		}

		const originalTick = state.hooks.tick.bind(state.hooks);
		const originalClearRemoteCar = state.hooks.clearRemoteCar.bind(state.hooks);
		const originalLeaveScene = state.hooks.leaveScene ? state.hooks.leaveScene.bind(state.hooks) : null;

		state.hooks.pushRemoteState = (carState) => {
			pushRemoteSample(carState);
		};
		state.hooks.tick = (deltaSeconds) => {
			renderSmoothedRemoteCar();
			originalTick(deltaSeconds);
		};
		state.hooks.clearRemoteCar = () => {
			resetRemoteSmoothing();
			originalClearRemoteCar();
		};
		if (originalLeaveScene) {
			state.hooks.leaveScene = () => {
				resetRemoteSmoothing();
				originalLeaveScene();
			};
		}

		state.hooks.__polytrackSmoothingInstalled = true;
	};

	const setStatus = (text, tone = "info") => {
		if (!state.dom.status) {
			return;
		}
		state.dom.status.textContent = text;
		state.dom.status.dataset.tone = tone;
	};

	const updatePeerCount = (count = 0) => {
		if (!state.dom.peerCount) {
			return;
		}
		state.dom.peerCount.textContent = `${count} peer${1 === count ? "" : "s"}`;
	};

	const ensurePlayer = (playerId, defaults = {}) => {
		if (!playerId) {
			return null;
		}
		const existing = state.players.get(playerId) || {
			id: playerId,
			name: playerId === state.playerId ? state.playerName : "Friend",
			isSelf: playerId === state.playerId,
			ready: false,
			connected: true,
			checkpoint: 0,
			timeFrames: 0,
			totalFrames: 0,
			speedKmh: 0,
			hasFinished: false,
			finishFrames: null,
			finishAt: null,
			crashes: 0,
			restarts: 0,
		};
		Object.assign(existing, defaults);
		state.players.set(playerId, existing);
		return existing;
	};

	const savePlayerName = () => {
		state.playerName = (state.dom.playerName && state.dom.playerName.value.trim() ? state.dom.playerName.value.trim() : state.playerName).slice(0, 24);
		ensurePlayer(state.playerId, { name: state.playerName, isSelf: true });
		try {
			localStorage.setItem(PLAYER_NAME_KEY, state.playerName);
		} catch (_error) {
			// Local storage can fail in restrictive contexts; the session name still works.
		}
		sendProfile();
		renderLeaderboard();
	};

	const sendProfile = () => {
		send({ type: "profile", playerId: state.playerId, name: state.playerName });
	};

	const sendReady = (ready) => {
		state.localReady = !!ready;
		state.localFinishSent = false;
		ensurePlayer(state.playerId, { name: state.playerName, isSelf: true, ready: state.localReady, hasFinished: false, finishFrames: null, finishAt: null });
		setRacePaused(state.localReady && "running" !== state.race.phase);
		send({ type: "ready", playerId: state.playerId, name: state.playerName, ready: state.localReady });
		updateUi();
		renderLeaderboard();
	};

	const setRacePaused = (paused) => {
		if (state.hooks && "function" === typeof state.hooks.setRacePaused) {
			state.hooks.setRacePaused(!!paused);
		}
	};

	const resetLocalRun = () => {
		try {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", key: "r", bubbles: true }));
		} catch (_error) {
			// Some browsers do not allow synthetic keyboard construction; rematch still resets the lobby state.
		}
	};

	const renderCountdown = () => {
		if (!state.dom.countdown) {
			return;
		}
		if ("countdown" !== state.race.phase) {
			state.dom.countdown.hidden = true;
			return;
		}
		const remaining = state.race.startAt - getServerNow();
		state.dom.countdown.hidden = false;
		state.dom.countdown.textContent = remaining <= 0 ? "GO" : `${Math.max(1, Math.ceil(remaining / 1000))}`;
	};

	const updateRaceClock = () => {
		if (!state.dom.raceClock) {
			return;
		}
		if ("running" === state.race.phase) {
			state.dom.raceClock.textContent = formatRaceTime(getServerNow() - state.race.startAt);
		} else if ("countdown" === state.race.phase) {
			state.dom.raceClock.textContent = "00:00.000";
		}
	};

	const stopRaceTimers = () => {
		if (state.race.countdownTimer) {
			clearInterval(state.race.countdownTimer);
			state.race.countdownTimer = null;
		}
		if (state.race.leaderboardTimer) {
			clearInterval(state.race.leaderboardTimer);
			state.race.leaderboardTimer = null;
		}
	};

	const startRaceTimers = () => {
		if (!state.race.leaderboardTimer) {
			state.race.leaderboardTimer = setInterval(() => {
				updateRaceClock();
				renderLeaderboard();
			}, LEADERBOARD_REFRESH_MS);
		}
	};

	const beginCountdown = (message) => {
		updateServerClock(message.serverTime);
		stopRaceTimers();
		state.race.phase = "countdown";
		state.race.raceId = message.raceId || `${Date.now()}`;
		state.race.startAt = Number(message.startAt) || getServerNow() + COUNTDOWN_MS;
		state.localFinishSent = false;
		state.players.forEach((player) => {
			player.hasFinished = false;
			player.finishFrames = null;
			player.finishAt = null;
		});
		setRacePaused(true);
		renderCountdown();
		setStatus("Race countdown started. Hold throttle for the launch.", "ok");
		state.race.countdownTimer = setInterval(() => {
			renderCountdown();
			if (getServerNow() >= state.race.startAt) {
				clearInterval(state.race.countdownTimer);
				state.race.countdownTimer = null;
				state.race.phase = "running";
				state.dom.countdown.textContent = "GO";
				window.setTimeout(() => {
					if (state.dom.countdown) {
						state.dom.countdown.hidden = true;
					}
				}, 650);
				setRacePaused(false);
				startRaceTimers();
				updateUi();
				renderLeaderboard();
			}
		}, 50);
		startRaceTimers();
		updateUi();
		renderLeaderboard();
	};

	const requestRaceStart = () => {
		if (!state.socket || WebSocket.OPEN !== state.socket.readyState) {
			setStatus("Connect or create a room before starting a race.", "warn");
			return;
		}
		if (!state.isHosting) {
			setStatus("Only the room host can start the countdown.", "warn");
			return;
		}
		savePlayerName();
		send({ type: "race", event: "start-request", raceId: `race-${Date.now().toString(36)}`, countdownMs: COUNTDOWN_MS });
	};

	const resetRaceState = (fromNetwork = false) => {
		stopRaceTimers();
		state.race.phase = "idle";
		state.race.raceId = null;
		state.race.startAt = 0;
		state.localReady = false;
		state.localFinishSent = false;
		state.players.forEach((player) => {
			player.ready = false;
			player.hasFinished = false;
			player.finishFrames = null;
			player.finishAt = null;
			player.timeFrames = 0;
			player.totalFrames = 0;
			player.checkpoint = 0;
			player.speedKmh = 0;
		});
		setRacePaused(false);
		if (state.dom.countdown) {
			state.dom.countdown.hidden = true;
		}
		if (state.dom.results) {
			state.dom.results.hidden = true;
		}
		resetLocalRun();
		if (!fromNetwork) {
			send({ type: "race", event: "rematch-request", raceId: `race-${Date.now().toString(36)}` });
		}
		setStatus("Rematch ready. Everyone can ready up again.", "ok");
		updateUi();
		renderLeaderboard();
	};

	const playerSortValue = (player) => {
		if (player.hasFinished) {
			return [-1, player.finishFrames || player.totalFrames || player.timeFrames || Number.MAX_SAFE_INTEGER];
		}
		return [0, -(player.checkpoint || 0), player.timeFrames || Number.MAX_SAFE_INTEGER];
	};

	const getSortedPlayers = () => Array.from(state.players.values()).sort((left, right) => {
		const leftValue = playerSortValue(left);
		const rightValue = playerSortValue(right);
		for (let index = 0; index < leftValue.length; index++) {
			if (leftValue[index] !== rightValue[index]) {
				return leftValue[index] - rightValue[index];
			}
		}
		return left.name.localeCompare(right.name);
	});

	const renderLeaderboard = () => {
		if (!state.dom.leaderboard) {
			return;
		}
		ensurePlayer(state.playerId, { name: state.playerName, isSelf: true, ready: state.localReady });
		const players = getSortedPlayers();
		state.dom.leaderboard.innerHTML = players.map((player, index) => {
			const status = player.hasFinished ? "FIN" : player.ready ? "RDY" : "RUN";
			const time = player.hasFinished ? formatFrames(player.finishFrames || player.totalFrames) : "running" === state.race.phase ? formatRaceTime(getServerNow() - state.race.startAt) : formatFrames(player.timeFrames);
			const checkpoint = player.hasFinished ? "Finish" : `CP ${player.checkpoint || 0}`;
			const speed = `${Math.round(player.speedKmh || 0)} km/h`;
			return `<div class="multiplayer-leaderboard-row${player.isSelf ? " self" : ""}">
				<span class="place">${index + 1}</span>
				<span class="name">${escapeHtml(player.name || "Friend")}</span>
				<span class="checkpoint">${checkpoint}</span>
				<span class="time">${time}</span>
				<span class="speed">${speed}</span>
				<span class="badge">${status}</span>
			</div>`;
		}).join("") || `<div class="multiplayer-empty">No racers yet.</div>`;
		maybeShowResults();
	};

	const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[character]));

	const maybeShowResults = () => {
		if (!state.dom.results || "running" !== state.race.phase && "results" !== state.race.phase) {
			return;
		}
		const players = getSortedPlayers();
		const finished = players.filter((player) => player.hasFinished);
		if (0 === finished.length) {
			return;
		}
		const activePlayers = players.filter((player) => player.ready || player.hasFinished || player.isSelf);
		const everyoneFinished = activePlayers.length > 0 && activePlayers.every((player) => player.hasFinished);
		if (!everyoneFinished && !ensurePlayer(state.playerId).hasFinished) {
			return;
		}
		state.race.phase = "results";
		state.dom.results.hidden = false;
		state.dom.resultsList.innerHTML = finished.map((player, index) => `<div class="multiplayer-result-row${player.isSelf ? " self" : ""}">
			<span>${index + 1}. ${escapeHtml(player.name || "Friend")}</span>
			<strong>${formatFrames(player.finishFrames || player.totalFrames)}</strong>
		</div>`).join("");
		updateUi();
	};

	const updateLocalPlayerFromState = (carState) => {
		if (!carState) {
			return;
		}
		const player = ensurePlayer(state.playerId, {
			name: state.playerName,
			isSelf: true,
			ready: state.localReady,
			checkpoint: carState.nextCheckpointIndex || 0,
			timeFrames: carState.frames || 0,
			totalFrames: carState.totalFrames || 0,
			speedKmh: carState.speedKmh || 0,
			hasFinished: !!carState.hasFinished,
		});
		if (carState.hasFinished && !state.localFinishSent && state.race.raceId) {
			state.localFinishSent = true;
			player.finishFrames = carState.totalFrames || carState.frames || Math.max(0, getServerNow() - state.race.startAt);
			player.finishAt = getServerNow();
			send({
				type: "result",
				playerId: state.playerId,
				name: state.playerName,
				raceId: state.race.raceId,
				finishFrames: player.finishFrames,
				finishAt: player.finishAt,
			});
			setStatus("Finished. Waiting for results.", "ok");
			renderLeaderboard();
		}
	};

	const updatePeerFromState = (playerId, name, carState) => {
		if (!playerId || playerId === state.playerId || !carState) {
			return;
		}
		ensurePlayer(playerId, {
			name: name || (state.players.get(playerId) && state.players.get(playerId).name) || "Friend",
			isSelf: false,
			connected: true,
			checkpoint: carState.nextCheckpointIndex || 0,
			timeFrames: carState.frames || 0,
			totalFrames: carState.totalFrames || 0,
			speedKmh: carState.speedKmh || 0,
			hasFinished: !!carState.hasFinished,
			finishFrames: carState.hasFinished ? carState.totalFrames || carState.frames : (state.players.get(playerId) && state.players.get(playerId).finishFrames) || null,
		});
		renderLeaderboard();
	};

	const clearRemoteCar = () => {
		if (state.hooks && "function" === typeof state.hooks.clearRemoteCar) {
			state.hooks.clearRemoteCar();
		}
	};

	const send = (message) => {
		if (!state.socket || WebSocket.OPEN !== state.socket.readyState) {
			return;
		}
		state.socket.send(JSON.stringify(message));
	};

	const normalizeUrl = (value, port) => {
		const trimmed = value.trim();
		if ("" === trimmed) {
			return `ws://127.0.0.1:${port}`;
		}
		const roomUrl = decodeRoomCode(trimmed);
		if (roomUrl) {
			return roomUrl;
		}
		if (/^wss?:\/\//i.test(trimmed)) {
			return trimmed;
		}
		if (/^\d+$/.test(trimmed)) {
			return `ws://127.0.0.1:${trimmed}`;
		}
		if (trimmed.includes(":")) {
			return `ws://${trimmed}`;
		}
		return `ws://${trimmed}:${port}`;
	};

	const refreshHostInfo = () => {
		if (!state.dom.hostInfo) {
			return;
		}
		if (!state.hostInfo || !state.hostInfo.urls || 0 === state.hostInfo.urls.length) {
			state.dom.hostInfo.textContent = "Room code and host addresses will appear here.";
			return;
		}
		const roomCode = getShareRoomCode();
		state.dom.hostInfo.textContent = `${roomCode ? `Room code: ${roomCode}\n` : ""}${state.hostInfo.urls.join("\n")}`;
	};

	const openAnotherWindow = () => {
		if (!window.electron || "function" !== typeof window.electron.newWindow) {
			setStatus("Opening another game window only works in the Electron desktop app.", "error");
			return;
		}
		window.electron.newWindow();
		setStatus("Opened another game window. Join the host from that second window.", "ok");
	};

	const updateUi = () => {
		if (!state.dom.panel || !state.dom.toggle) {
			return;
		}
		state.dom.panel.hidden = !state.panelOpen;
		state.dom.toggle.textContent = state.panelOpen ? "Hide Online" : "Online";
		state.dom.startHost.disabled = state.isHosting;
		state.dom.join.disabled = state.isHosting;
		state.dom.stop.disabled = !state.isHosting && !state.socket;
		state.dom.joinUrl.disabled = state.isHosting;
		state.dom.port.disabled = !!state.socket;
		state.dom.newWindow.disabled = !window.electron || "function" !== typeof window.electron.newWindow;
		if (state.dom.ready) {
			state.dom.ready.disabled = !state.socket || "countdown" === state.race.phase || "running" === state.race.phase;
			state.dom.ready.textContent = state.localReady ? "Unready" : "Ready";
		}
		if (state.dom.startRace) {
			state.dom.startRace.disabled = !state.socket || !state.isHosting || "countdown" === state.race.phase || "running" === state.race.phase;
		}
		if (state.dom.rematch) {
			state.dom.rematch.disabled = !state.socket && !state.isHosting;
		}
	};

	const handleMessage = (message) => {
		if (!message || "object" !== typeof message) {
			return;
		}
		updateServerClock(message.serverTime);
		if ("server" === message.type && "peer-count" === message.event) {
			updatePeerCount(message.peers || 0);
			if (state.isHosting && message.peers > 0) {
				setStatus("Friend connected. Load the same track, ready up, then start the race.", "ok");
			}
			return;
		}
		if ("server" === message.type && "peer-left" === message.event) {
			renderLeaderboard();
			return;
		}
		if ("hello" === message.type) {
			if (message.playerId && message.playerId !== state.playerId) {
				ensurePlayer(message.playerId, { name: message.name || "Friend", isSelf: false, connected: true });
				sendProfile();
				send({ type: "ready", playerId: state.playerId, name: state.playerName, ready: state.localReady });
				renderLeaderboard();
			}
			setStatus("Friend connected. Load the same track, ready up, then start the race.", "ok");
			return;
		}
		if ("profile" === message.type && message.playerId && message.playerId !== state.playerId) {
			ensurePlayer(message.playerId, { name: message.name || "Friend", isSelf: false, connected: true });
			renderLeaderboard();
			return;
		}
		if ("ready" === message.type && message.playerId && message.playerId !== state.playerId) {
			ensurePlayer(message.playerId, { name: message.name || "Friend", isSelf: false, ready: !!message.ready, connected: true });
			renderLeaderboard();
			return;
		}
		if ("race" === message.type && "countdown" === message.event) {
			beginCountdown(message);
			return;
		}
		if ("race" === message.type && "rematch" === message.event) {
			resetRaceState(true);
			return;
		}
		if ("result" === message.type && message.playerId && message.playerId !== state.playerId) {
			ensurePlayer(message.playerId, {
				name: message.name || "Friend",
				isSelf: false,
				hasFinished: true,
				finishFrames: message.finishFrames,
				finishAt: message.finishAt,
			});
			renderLeaderboard();
			return;
		}
		if ("state" === message.type && message.state && state.hooks && "function" === typeof state.hooks.pushRemoteState) {
			updatePeerFromState(message.playerId, message.name, message.state);
			state.hooks.pushRemoteState(message.state);
		}
	};

	const disconnectSocket = () => {
		stopRaceTimers();
		state.race.phase = "idle";
		state.race.raceId = null;
		if (!state.socket) {
			clearRemoteCar();
			updatePeerCount(0);
			state.players.clear();
			ensurePlayer(state.playerId, { name: state.playerName, isSelf: true });
			state.localReady = false;
			setRacePaused(false);
			renderLeaderboard();
			updateUi();
			return;
		}
		const socket = state.socket;
		state.socket = null;
		socket.onopen = null;
		socket.onclose = null;
		socket.onerror = null;
		socket.onmessage = null;
		try {
			socket.close();
		} catch (_error) {
			// Ignore close failures during teardown.
		}
		clearRemoteCar();
		updatePeerCount(0);
		state.players.clear();
		ensurePlayer(state.playerId, { name: state.playerName, isSelf: true });
		state.localReady = false;
		setRacePaused(false);
		renderLeaderboard();
		updateUi();
	};

	const connect = (url) => {
		disconnectSocket();
		setStatus(`Connecting to ${url}...`, "info");
		const socket = new WebSocket(url);
		state.socket = socket;
		updateUi();

		socket.onopen = () => {
			state.lastSnapshotAt = 0;
			savePlayerName();
			ensurePlayer(state.playerId, { name: state.playerName, isSelf: true, connected: true });
			send({ type: "hello", role: state.isHosting ? "host" : "guest", playerId: state.playerId, name: state.playerName });
			sendProfile();
			setStatus(state.isHosting ? "Room created. Share the room code, load a track, and ready up." : "Joined room. Load the same track, ready up, then race.", "ok");
			renderLeaderboard();
			updateUi();
		};

		socket.onmessage = (event) => {
			try {
				handleMessage(JSON.parse(event.data));
			} catch (_error) {
				// Ignore malformed packets.
			}
		};

		socket.onerror = () => {
			setStatus("Connection failed.", "error");
		};

		socket.onclose = () => {
			if (state.socket === socket) {
				state.socket = null;
				clearRemoteCar();
				updatePeerCount(0);
				state.localReady = false;
				setRacePaused(false);
				setStatus(state.isHosting && state.hostInfo ? "Host is still running. Waiting for a friend to connect." : "Disconnected.", "warn");
				renderLeaderboard();
				updateUi();
			}
		};
	};

	const stop = async () => {
		disconnectSocket();
		if (state.isHosting && window.electron && window.electron.multiplayer) {
			try {
				await window.electron.multiplayer.stopHost();
			} catch (_error) {
				// Ignore host shutdown errors during cleanup.
			}
		}
		state.isHosting = false;
		state.hostInfo = null;
		refreshHostInfo();
		setStatus("Offline.", "info");
		updateUi();
	};

	const startHost = async () => {
		if (!window.electron || !window.electron.multiplayer) {
			setStatus("Host mode only works in the Electron desktop app.", "error");
			return;
		}
		const port = Number(state.dom.port.value) || DEFAULT_PORT;
		try {
			state.hostInfo = await window.electron.multiplayer.startHost(port);
			state.isHosting = true;
			refreshHostInfo();
			updateUi();
			connect(`ws://127.0.0.1:${state.hostInfo.port}`);
		} catch (error) {
			setStatus(error && error.message ? error.message : "Could not start the host.", "error");
		}
	};

	const join = () => {
		state.isHosting = false;
		state.hostInfo = null;
		refreshHostInfo();
		updateUi();
		connect(normalizeUrl(state.dom.joinUrl.value, Number(state.dom.port.value) || DEFAULT_PORT));
	};

	const attachHooks = () => {
		if (!window.__polytrackMpHooks) {
			window.setTimeout(attachHooks, 250);
			return;
		}
		state.hooks = window.__polytrackMpHooks;
		installRemoteSmoothing();
		state.hooks.onLocalState = (carState) => {
			updateLocalPlayerFromState(carState);
			if (!state.socket || WebSocket.OPEN !== state.socket.readyState) {
				return;
			}
			if (!state.hooks.isSpeedTestActive || !state.hooks.isSpeedTestActive()) {
				return;
			}
			const now = performance.now();
			if (now - state.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) {
				return;
			}
			state.lastSnapshotAt = now;
			send({ type: "state", playerId: state.playerId, name: state.playerName, raceId: state.race.raceId, sentAt: now, state: carState });
		};
	};

	const buildUi = () => {
		const style = document.createElement("style");
		style.textContent = `
#multiplayer-toggle {
	position: fixed;
	top: 16px;
	right: 16px;
	z-index: 40;
	padding: 10px 14px;
	border: 0;
	border-radius: 999px;
	background: rgba(17, 24, 39, 0.92);
	color: #f8fafc;
	font: 600 13px/1.2 "Trebuchet MS", sans-serif;
	letter-spacing: 0.04em;
	cursor: pointer;
	box-shadow: 0 10px 30px rgba(15, 23, 42, 0.25);
}
#multiplayer-panel {
	position: fixed;
	top: 64px;
	right: 16px;
	z-index: 40;
	width: min(460px, calc(100vw - 32px));
	padding: 16px;
	border-radius: 18px;
	background: linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(30, 41, 59, 0.94));
	color: #e2e8f0;
	font: 14px/1.45 "Trebuchet MS", sans-serif;
	box-shadow: 0 18px 40px rgba(15, 23, 42, 0.35);
	backdrop-filter: blur(12px);
}
#multiplayer-panel[hidden] {
	display: none;
}
#multiplayer-panel h2 {
	margin: 0 0 8px;
	font-size: 18px;
	letter-spacing: 0.04em;
}
#multiplayer-panel p {
	margin: 0 0 10px;
	color: #cbd5e1;
}
#multiplayer-panel .row {
	display: flex;
	gap: 8px;
	margin-bottom: 8px;
}
#multiplayer-panel input,
#multiplayer-panel button {
	border: 0;
	border-radius: 10px;
	padding: 10px 12px;
	font: inherit;
}
#multiplayer-panel input {
	flex: 1;
	background: rgba(255, 255, 255, 0.08);
	color: #f8fafc;
}
#multiplayer-panel button {
	background: #f97316;
	color: #111827;
	font-weight: 700;
	cursor: pointer;
}
#multiplayer-panel button.secondary {
	background: rgba(255, 255, 255, 0.12);
	color: #f8fafc;
}
#multiplayer-panel button:disabled {
	opacity: 0.45;
	cursor: default;
}
#multiplayer-status {
	margin: 10px 0;
	padding: 10px 12px;
	border-radius: 12px;
	background: rgba(148, 163, 184, 0.12);
	color: #e2e8f0;
}
#multiplayer-status[data-tone="ok"] {
	background: rgba(34, 197, 94, 0.16);
	color: #dcfce7;
}
#multiplayer-status[data-tone="warn"] {
	background: rgba(234, 179, 8, 0.16);
	color: #fef3c7;
}
#multiplayer-status[data-tone="error"] {
	background: rgba(239, 68, 68, 0.18);
	color: #fee2e2;
}
#multiplayer-host-info {
	padding: 10px 12px;
	border-radius: 12px;
	background: rgba(255, 255, 255, 0.06);
	white-space: pre-wrap;
	word-break: break-word;
}
#multiplayer-meta {
	display: flex;
	justify-content: space-between;
	margin-top: 10px;
	color: #94a3b8;
	font-size: 12px;
}
#multiplayer-race-tools {
	display: grid;
	grid-template-columns: 1fr 1fr 1fr;
	gap: 8px;
	margin: 10px 0;
}
#multiplayer-race-clock {
	margin: 8px 0;
	font-size: 24px;
	font-weight: 800;
	font-variant-numeric: tabular-nums;
	text-align: center;
	color: #f8fafc;
}
#multiplayer-leaderboard {
	display: grid;
	gap: 4px;
	margin-top: 10px;
	max-height: 190px;
	overflow-y: auto;
}
.multiplayer-leaderboard-row {
	display: grid;
	grid-template-columns: 26px minmax(82px, 1fr) 54px 82px 64px 40px;
	align-items: center;
	gap: 6px;
	padding: 7px 8px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.07);
	font-size: 12px;
}
.multiplayer-leaderboard-row.self {
	outline: 1px solid rgba(249, 115, 22, 0.75);
}
.multiplayer-leaderboard-row .place,
.multiplayer-leaderboard-row .time,
.multiplayer-leaderboard-row .speed {
	font-variant-numeric: tabular-nums;
}
.multiplayer-leaderboard-row .name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.multiplayer-leaderboard-row .badge {
	justify-self: end;
	padding: 2px 5px;
	border-radius: 6px;
	background: rgba(249, 115, 22, 0.22);
	color: #fed7aa;
	font-size: 10px;
	font-weight: 800;
}
.multiplayer-empty {
	padding: 10px;
	color: #94a3b8;
	text-align: center;
}
#multiplayer-countdown {
	position: fixed;
	inset: 0;
	z-index: 45;
	display: grid;
	place-items: center;
	color: #f8fafc;
	font: 900 min(24vw, 190px)/1 "Trebuchet MS", sans-serif;
	text-shadow: 0 10px 35px rgba(0, 0, 0, 0.65);
	pointer-events: none;
}
#multiplayer-countdown[hidden],
#multiplayer-results[hidden] {
	display: none;
}
#multiplayer-results {
	position: fixed;
	left: 50%;
	top: 50%;
	z-index: 46;
	width: min(420px, calc(100vw - 32px));
	transform: translate(-50%, -50%);
	padding: 18px;
	border-radius: 12px;
	background: rgba(15, 23, 42, 0.96);
	color: #f8fafc;
	box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
}
#multiplayer-results h2 {
	margin: 0 0 12px;
}
.multiplayer-result-row {
	display: flex;
	justify-content: space-between;
	gap: 16px;
	padding: 8px 0;
	border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}
.multiplayer-result-row.self {
	color: #fed7aa;
}
#multiplayer-results button {
	margin-top: 14px;
	width: 100%;
	border: 0;
	border-radius: 10px;
	padding: 10px 12px;
	background: #f97316;
	color: #111827;
	font-weight: 800;
	cursor: pointer;
}
`;
		document.head.appendChild(style);

		const root = document.createElement("div");
		root.innerHTML = `
<button id="multiplayer-toggle" type="button">Hide Online</button>
<section id="multiplayer-panel">
	<h2>Online Lobby</h2>
	<p>Create a room, share the room code, load the same track, and start together.</p>
	<div class="row">
		<input id="multiplayer-name" type="text" maxlength="24" placeholder="Player name">
	</div>
	<div class="row">
		<input id="multiplayer-port" type="number" min="1024" max="65535" value="32323" placeholder="Port">
		<button id="multiplayer-host" type="button">Create Room</button>
	</div>
	<div class="row">
		<input id="multiplayer-join" type="text" placeholder="Room code or ws://host-ip:32323">
		<button id="multiplayer-join-button" type="button" class="secondary">Join</button>
	</div>
	<div id="multiplayer-race-tools">
		<button id="multiplayer-ready" type="button" class="secondary">Ready</button>
		<button id="multiplayer-start-race" type="button">Start Race</button>
		<button id="multiplayer-rematch" type="button" class="secondary">Rematch</button>
	</div>
	<div id="multiplayer-race-clock">00:00.000</div>
	<div class="row">
		<button id="multiplayer-stop" type="button" class="secondary">Disconnect</button>
		<button id="multiplayer-new-window" type="button" class="secondary">New Window</button>
	</div>
	<div id="multiplayer-status" data-tone="info">Offline.</div>
	<div id="multiplayer-host-info">Room code and host addresses will appear here.</div>
	<div id="multiplayer-leaderboard"></div>
	<div id="multiplayer-meta">
		<span>F8 toggles this panel, Ctrl+Shift+N opens a new window</span>
		<span id="multiplayer-peer-count">0 peers</span>
	</div>
</section>
<div id="multiplayer-countdown" hidden>3</div>
<section id="multiplayer-results" hidden>
	<h2>Finish Results</h2>
	<div id="multiplayer-results-list"></div>
	<button id="multiplayer-results-rematch" type="button">Rematch</button>
</section>`;
		document.body.appendChild(root);

		state.dom.toggle = root.querySelector("#multiplayer-toggle");
		state.dom.panel = root.querySelector("#multiplayer-panel");
		state.dom.playerName = root.querySelector("#multiplayer-name");
		state.dom.port = root.querySelector("#multiplayer-port");
		state.dom.startHost = root.querySelector("#multiplayer-host");
		state.dom.joinUrl = root.querySelector("#multiplayer-join");
		state.dom.join = root.querySelector("#multiplayer-join-button");
		state.dom.ready = root.querySelector("#multiplayer-ready");
		state.dom.startRace = root.querySelector("#multiplayer-start-race");
		state.dom.rematch = root.querySelector("#multiplayer-rematch");
		state.dom.raceClock = root.querySelector("#multiplayer-race-clock");
		state.dom.stop = root.querySelector("#multiplayer-stop");
		state.dom.newWindow = root.querySelector("#multiplayer-new-window");
		state.dom.status = root.querySelector("#multiplayer-status");
		state.dom.hostInfo = root.querySelector("#multiplayer-host-info");
		state.dom.leaderboard = root.querySelector("#multiplayer-leaderboard");
		state.dom.countdown = root.querySelector("#multiplayer-countdown");
		state.dom.results = root.querySelector("#multiplayer-results");
		state.dom.resultsList = root.querySelector("#multiplayer-results-list");
		state.dom.resultsRematch = root.querySelector("#multiplayer-results-rematch");
		state.dom.peerCount = root.querySelector("#multiplayer-peer-count");
		state.dom.playerName.value = state.playerName;

		state.dom.toggle.addEventListener("click", () => {
			state.panelOpen = !state.panelOpen;
			updateUi();
		});
		state.dom.playerName.addEventListener("change", () => {
			savePlayerName();
		});
		state.dom.startHost.addEventListener("click", () => {
			startHost();
		});
		state.dom.join.addEventListener("click", () => {
			join();
		});
		state.dom.ready.addEventListener("click", () => {
			savePlayerName();
			sendReady(!state.localReady);
		});
		state.dom.startRace.addEventListener("click", () => {
			requestRaceStart();
		});
		state.dom.rematch.addEventListener("click", () => {
			resetRaceState(false);
		});
		state.dom.stop.addEventListener("click", () => {
			stop();
		});
		state.dom.newWindow.addEventListener("click", () => {
			openAnotherWindow();
		});
		state.dom.resultsRematch.addEventListener("click", () => {
			resetRaceState(false);
		});
		window.addEventListener("keydown", (event) => {
			if ("F8" === event.code) {
				event.preventDefault();
				state.panelOpen = !state.panelOpen;
				updateUi();
			}
		});
		window.addEventListener("beforeunload", () => {
			stop();
		});

		refreshHostInfo();
		updatePeerCount(0);
		ensurePlayer(state.playerId, { name: state.playerName, isSelf: true });
		renderLeaderboard();
		updateUi();
	};

	if ("loading" === document.readyState) {
		document.addEventListener("DOMContentLoaded", buildUi, { once: true });
	} else {
		buildUi();
	}
	attachHooks();
})();
