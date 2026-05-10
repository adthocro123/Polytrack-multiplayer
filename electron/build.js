const fs = require("fs");
const path = require("path");
const packager = require("@electron/packager");

const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dist");
const appName = "PolyTrack Online";

const cliOptions = process.argv.slice(2).reduce((options, arg) => {
	const match = arg.match(/^--([^=]+)=(.+)$/);
	if (match) {
		options[match[1]] = match[2];
	}
	return options;
}, {});
const platform = cliOptions.platform || process.env.POLYTRACK_PLATFORM || process.platform;
const arch = cliOptions.arch || process.env.POLYTRACK_ARCH || process.arch;

const requiredFiles = [
	"index.html",
	"main.bundle.js",
	"simulation_worker.bundle.js",
	"multiplayer.js",
	"manifest.json",
	"electron/main.js",
	"electron/preload.js",
	"electron/multiplayer-host.js",
];

for (const file of requiredFiles) {
	const fullPath = path.join(rootDir, file);
	if (!fs.existsSync(fullPath)) {
		throw new Error(`Cannot package the app because ${file} is missing.`);
	}
}

const ignoredPaths = [
	/^\/dist($|\/)/,
	/^\/\.git($|\/)/,
	/^\/README\.md$/,
	/^\/electron\/build\.js$/,
	/^\/package-lock\.json$/,
];

const shouldIgnore = (filePath) => {
	if (!filePath) {
		return false;
	}
	const normalized = filePath.replace(/\\/g, "/");
	return ignoredPaths.some((pattern) => pattern.test(normalized));
};

const writeShareNotes = (appPaths) => {
	for (const appPath of appPaths) {
		const launchName = platform === "win32" ? `${appName}.exe` : `${appName}.app`;
		const notesPath = path.join(appPath, "READ_ME_TO_PLAY_ONLINE.txt");
		const notes = [
			"PolyTrack Online",
			"",
			`Build target: ${platform}-${arch}`,
			`Launch: ${launchName}`,
			"",
			"How to play with friends:",
			"1. Open the app.",
			"2. One player clicks Start Host in the Online Runway panel.",
			"3. Players on the same Wi-Fi/LAN join using the ws:// address shown by the host.",
			"4. Both players open the Test runway from the main menu.",
			"",
			platform === "darwin"
				? "On macOS, right-click the app and choose Open the first time if Gatekeeper blocks it."
				: "If Windows Firewall asks, allow private network access for the app.",
			platform === "darwin"
				? "If macOS asks about incoming network connections, allow it for host mode."
				: "",
			"Friends outside your home network need port forwarding for TCP port 32323 or a tunnel.",
			"",
			"Default online port: 32323",
			"",
		].filter(Boolean).join("\r\n");

		fs.writeFileSync(notesPath, notes, "utf8");
	}
};

(async () => {
	console.log(`Packaging ${appName} for ${platform}-${arch}...`);

	const appPaths = await packager({
		dir: rootDir,
		name: appName,
		executableName: appName,
		out: outDir,
		overwrite: true,
		platform,
		arch,
		prune: true,
		ignore: shouldIgnore,
		appCopyright: "PolyTrack",
		win32metadata: {
			CompanyName: "PolyTrack",
			FileDescription: appName,
			OriginalFilename: `${appName}.exe`,
			ProductName: appName,
			InternalName: appName,
		},
	});

	writeShareNotes(appPaths);

	if (0 === appPaths.length) {
		throw new Error(`No app was created for ${platform}-${arch}. If you are building macOS from Windows, run this script on the Mac instead.`);
	}

	console.log("Packaged app:");
	for (const appPath of appPaths) {
		console.log(`- ${appPath}`);
	}
})();
