(() => {
	const DEFAULT_PORT = 32323;
	const SNAPSHOT_INTERVAL_MS = 33;
	const INTERPOLATION_DELAY_MS = 80;
	const MAX_EXTRAPOLATION_MS = 120;
	const MAX_REMOTE_SAMPLES = 12;
	const REMOTE_STALE_MS = 1500;
	const state = {
		hooks: null,
		socket: null,
		isHosting: false,
		hostInfo: null,
		lastSnapshotAt: 0,
		remoteSamples: [],
		previousRemoteSample: null,
		lastRenderedRemoteFrame: null,
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
			state.dom.hostInfo.textContent = "Host addresses will appear here.";
			return;
		}
		state.dom.hostInfo.textContent = state.hostInfo.urls.join("\n");
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
	};

	const handleMessage = (message) => {
		if (!message || "object" !== typeof message) {
			return;
		}
		if ("server" === message.type && "peer-count" === message.event) {
			updatePeerCount(message.peers || 0);
			if (state.isHosting && message.peers > 0) {
				setStatus("Friend connected. Open the same track on both PCs.", "ok");
			}
			return;
		}
		if ("hello" === message.type) {
			setStatus("Friend connected. Open the same track on both PCs.", "ok");
			return;
		}
		if ("state" === message.type && message.state && state.hooks && "function" === typeof state.hooks.pushRemoteState) {
			state.hooks.pushRemoteState(message.state);
		}
	};

	const disconnectSocket = () => {
		if (!state.socket) {
			clearRemoteCar();
			updatePeerCount(0);
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
			send({ type: "hello", role: state.isHosting ? "host" : "guest" });
			setStatus(state.isHosting ? "Host ready. Share one of the host URLs below, then open the same track." : "Connected. Open the same track on both PCs.", "ok");
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
				setStatus(state.isHosting && state.hostInfo ? "Host is still running. Waiting for a friend to connect." : "Disconnected.", "warn");
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
			send({ type: "state", sentAt: now, state: carState });
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
	width: min(360px, calc(100vw - 32px));
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
`;
		document.head.appendChild(style);

		const root = document.createElement("div");
		root.innerHTML = `
<button id="multiplayer-toggle" type="button">Hide Online</button>
<section id="multiplayer-panel">
	<h2>Online Runway</h2>
	<p>Host a session, share the ws:// address, and have both players open the same track.</p>
	<div class="row">
		<input id="multiplayer-port" type="number" min="1024" max="65535" value="32323" placeholder="Port">
		<button id="multiplayer-host" type="button">Start Host</button>
	</div>
	<div class="row">
		<input id="multiplayer-join" type="text" placeholder="ws://host-ip:32323 or host-ip">
		<button id="multiplayer-join-button" type="button" class="secondary">Join</button>
	</div>
	<div class="row">
		<button id="multiplayer-stop" type="button" class="secondary">Disconnect</button>
		<button id="multiplayer-new-window" type="button" class="secondary">New Window</button>
	</div>
	<div id="multiplayer-status" data-tone="info">Offline.</div>
	<div id="multiplayer-host-info">Host addresses will appear here.</div>
	<div id="multiplayer-meta">
		<span>F8 toggles this panel, Ctrl+Shift+N opens a new window</span>
		<span id="multiplayer-peer-count">0 peers</span>
	</div>
</section>`;
		document.body.appendChild(root);

		state.dom.toggle = root.querySelector("#multiplayer-toggle");
		state.dom.panel = root.querySelector("#multiplayer-panel");
		state.dom.port = root.querySelector("#multiplayer-port");
		state.dom.startHost = root.querySelector("#multiplayer-host");
		state.dom.joinUrl = root.querySelector("#multiplayer-join");
		state.dom.join = root.querySelector("#multiplayer-join-button");
		state.dom.stop = root.querySelector("#multiplayer-stop");
		state.dom.newWindow = root.querySelector("#multiplayer-new-window");
		state.dom.status = root.querySelector("#multiplayer-status");
		state.dom.hostInfo = root.querySelector("#multiplayer-host-info");
		state.dom.peerCount = root.querySelector("#multiplayer-peer-count");

		state.dom.toggle.addEventListener("click", () => {
			state.panelOpen = !state.panelOpen;
			updateUi();
		});
		state.dom.startHost.addEventListener("click", () => {
			startHost();
		});
		state.dom.join.addEventListener("click", () => {
			join();
		});
		state.dom.stop.addEventListener("click", () => {
			stop();
		});
		state.dom.newWindow.addEventListener("click", () => {
			openAnotherWindow();
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
		updateUi();
	};

	if ("loading" === document.readyState) {
		document.addEventListener("DOMContentLoaded", buildUi, { once: true });
	} else {
		buildUi();
	}
	attachHooks();
})();
