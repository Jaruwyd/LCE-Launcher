const { ipcRenderer: electronIpc, shell } = require('electron');
const nodeFs = require('fs');
const fsp = nodeFs.promises;
const nodePath = require('path');
const https = require('https');
const extractZip = require('extract-zip');
const childProcess = require('child_process');
const os = require('os');

window.__TAURI__ = window.__TAURI__ || {};
window.__TAURI__.core = {
    invoke: async (cmd, args = {}) => {
        switch (cmd) {
            case 'store_get':
                return electronIpc.invoke('store-get', args.key);
            case 'store_set':
                return electronIpc.invoke('store-set', args.key, args.value);
            case 'select_directory':
                return electronIpc.invoke('select-directory');
            case 'window_minimize':
                return electronIpc.send('window-minimize');
            case 'window_maximize':
                return electronIpc.send('window-maximize');
            case 'window_close':
                return electronIpc.send('window-close');
            case 'run_game': {
            const proc = childProcess.spawn(args.compatLayer && args.compatLayer !== 'direct' ? args.compatLayer : args.execPath, args.args || [], {
                cwd: args.cwd || nodePath.dirname(args.execPath),
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
            proc.unref();
            return proc.pid;
        }
            case 'download_and_extract':
                return downloadAndExtract(args.url, args.extractDir, args.preserveList || []);
            default:
                throw new Error(`Unsupported invoke: ${cmd}`);
        }
    },
    convertFileSrc: (p) => `file:///${p.replace(/\\/g, '/')}`
};

// Electron shim for Tauri helper used by audio skin/music loading
window.convertFileSrc = (p) => window.__TAURI__.core.convertFileSrc(p);

async function copyRecursive(src, dest) {
    const stat = await fsp.stat(src);
    if (stat.isDirectory()) {
        await fsp.mkdir(dest, { recursive: true });
        const entries = await fsp.readdir(src);
        for (const entry of entries) {
            await copyRecursive(nodePath.join(src, entry), nodePath.join(dest, entry));
        }
    } else {
        await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
        await fsp.copyFile(src, dest);
    }
}

async function downloadToFile(url, destPath, redirects = 0) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            { headers: { 'User-Agent': 'LCE-Launcher' } },
            (res) => {
                const code = res.statusCode || 0;
                const location = res.headers.location;
                if ([301, 302, 303, 307, 308].includes(code) && location) {
                    res.resume();
                    if (redirects >= 5) {
                        return reject(new Error("Too many redirects"));
                    }
                    return resolve(downloadToFile(location, destPath, redirects + 1));
                }
                if (code >= 400) {
                    return reject(new Error(`Download failed: ${code}`));
                }
                const file = nodeFs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
            }
        );
        req.on('error', reject);
    });
}

async function downloadAndExtract(url, extractDir, preserveList) {
    if (!url || url === 'local_copy') return;
    const tmpZip = nodePath.join(os.tmpdir(), `legacy_${Date.now()}.zip`);
    await downloadToFile(url, tmpZip);

    const backupDir = nodePath.join(nodePath.dirname(extractDir), 'LCEClient_Backup');
    if (nodeFs.existsSync(extractDir)) {
        if (nodeFs.existsSync(backupDir)) {
            await fsp.rm(backupDir, { recursive: true, force: true });
        }
        await fsp.mkdir(backupDir, { recursive: true });
        for (const item of preserveList) {
            const src = nodePath.join(extractDir, item);
            const dest = nodePath.join(backupDir, item);
            if (nodeFs.existsSync(src)) {
                await copyRecursive(src, dest);
            }
        }
        await fsp.rm(extractDir, { recursive: true, force: true });
    }

    await fsp.mkdir(extractDir, { recursive: true });
    await extractZip(tmpZip, { dir: extractDir });
    await fsp.rm(tmpZip, { force: true });

    if (nodeFs.existsSync(backupDir)) {
        for (const item of preserveList) {
            const src = nodePath.join(backupDir, item);
            const dest = nodePath.join(extractDir, item);
            if (nodeFs.existsSync(src)) {
                await copyRecursive(src, dest);
            }
        }
        await fsp.rm(backupDir, { recursive: true, force: true });
    }
}

window.__TAURI__.fs = {
    exists: async (p) => {
        try { await fsp.access(p); return true; } catch { return false; }
    },
    readDir: async (p) => {
        const entries = await fsp.readdir(p, { withFileTypes: true });
        return entries.map(e => ({ name: e.name, path: nodePath.join(p, e.name) }));
    },
    readFile: async (p) => {
        const buf = await fsp.readFile(p);
        return new Uint8Array(buf);
    },
    readTextFile: async (p) => await fsp.readFile(p, 'utf8'),
    writeFile: async (p, data) => {
        await fsp.mkdir(nodePath.dirname(p), { recursive: true });
        const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data);
        await fsp.writeFile(p, buf);
    },
    writeTextFile: async (p, data) => {
        await fsp.mkdir(nodePath.dirname(p), { recursive: true });
        await fsp.writeFile(p, data, 'utf8');
    },
    mkdir: async (p, opts) => await fsp.mkdir(p, opts),
    remove: async (p, opts) => await fsp.rm(p, { recursive: true, force: true, ...(opts || {}) }),
    chmodSync: nodeFs.chmodSync.bind(nodeFs)
};

window.__TAURI__.path = {
    join: async (...parts) => nodePath.join(...parts),
    dirname: async (p) => nodePath.dirname(p),
    basename: async (p) => nodePath.basename(p),
    homeDir: async () => os.homedir(),
    downloadDir: async () => nodePath.join(os.homedir(), 'Downloads')
};

window.__TAURI__.shell = {
    open: async (p) => shell.openPath(p)
};

window.__TAURI__.http = {
    fetch: (input, init) => fetch(input, init)
};

const ipcRenderer = {
    invoke: (cmd, ...args) => window.__TAURI__.core.invoke(cmd, ...args),
    on: (...args) => electronIpc.on(...args),
    send: (...args) => electronIpc.send(...args)
};
const shellApi = window.__TAURI__.shell;
const fs = window.__TAURI__.fs;
const path = window.__TAURI__.path;
async function safeExists(p) {
    if (!p || typeof p !== 'string') return false;
    return await window.__TAURI__.fs.exists(p);
}

// Normalize fs errors into safe fallbacks to avoid unhandled rejections on denied paths
(() => {
    const fsApi = window.__TAURI__.fs;
    const wrap = (name, fallback) => {
        const original = fsApi[name].bind(fsApi);
        fsApi[name] = async (...args) => {
            try {
                return await original(...args);
            } catch (e) {
                console.error(`fs.${name} error`, args[0], e);
                showToast(`Filesystem access blocked: ${args[0]}`);
                return fallback;
            }
        };
    };
    wrap('exists', false);
    wrap('readDir', []);
    wrap('readTextFile', "");
    wrap('mkdir', undefined);
    wrap('remove', undefined);
    wrap('writeTextFile', undefined);
})();

async function httpFetchJson(url, timeoutMs = 12000) {
    // A hung fetch will keep the startup "CONNECTING..." loader forever.
    // Always enforce a timeout and fall back to the Node HTTPS path.
    const doFetch = async (implFetch) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await implFetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: { 'Accept': 'application/vnd.github+json' }
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
            }
            return await res.json();
        } catch (e) {
            if (e?.name === 'AbortError') throw new Error('Request timed out');
            throw e;
        } finally {
            clearTimeout(t);
        }
    };

    try {
        if (window.__TAURI__?.http?.fetch) {
            return await doFetch(window.__TAURI__.http.fetch);
        }
        return await doFetch(fetch);
    } catch (e) {
        console.error("httpFetchJson error:", url, e);
        return await nodeFetchJson(url, timeoutMs);
    }
}

async function nodeFetchJson(url, timeoutMs = 12000) {
    return await new Promise((resolve, reject) => {
        const options = new URL(url);
        const req = https.request(
            {
                hostname: options.hostname,
                path: options.pathname + options.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'LCE-Launcher',
                    'Accept': 'application/vnd.github+json'
                }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim()));
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.setTimeout(timeoutMs, () => {
            try { req.destroy(new Error('Request timed out')); } catch (_) {}
        });
        req.on('error', (err) => {
            reject(err?.message === 'Request timed out' ? new Error('Request timed out') : err);
        });
        req.end();
    });
}

function getRepoSlug(repo) {
    if (!repo || typeof repo !== 'string') return DEFAULT_REPO;
    const trimmed = repo.trim();
    return trimmed.includes('/') ? trimmed : DEFAULT_REPO;
}

function applyNewsFallbackImages() {
    const fallback = "minecraft.jpg";
    const fallback2 = "minecraftlogo.png";
    const img1 = document.getElementById('news-img-1');
    const img2 = document.getElementById('news-img-2');
    const img3 = document.getElementById('news-img-3');
    if (img1 && !img1.style.backgroundImage) img1.style.backgroundImage = `url('${fallback}')`;
    if (img2 && !img2.style.backgroundImage) img2.style.backgroundImage = `url('${fallback2}')`;
    if (img3 && !img3.style.backgroundImage) img3.style.backgroundImage = `url('${fallback}')`;
}

async function loadInfoVersion() {
    const el = document.getElementById('info-version');
    if (!el) return;
    const url = "https://raw.githubusercontent.com/Jaruwyd/dropbox-blah/refs/heads/main/version.json";
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        let version = null;
        try {
            const data = JSON.parse(raw);
            version = data?.version ?? data?.current_version ?? data?.tag ?? data?.name ?? data?.build ?? data?.latest ?? data?.current;
        } catch (_) {
            const match = raw.match(/current_version"\s*:\s*"([^"]+)"/i);
            if (match) version = match[1];
            else version = raw.replace(/["'\s]+/g, '').trim();
        }
        if (version && typeof version === 'object') version = JSON.stringify(version);
        el.textContent = version ? String(version) : 'Unknown';
    } catch (e) {
        console.error('Failed to load version:', e);
        el.textContent = 'Unavailable';
    }
}

const DEFAULT_REPO = "smartcmd/MinecraftConsoles";
const DEFAULT_EXEC = "Minecraft.Client.exe";
const TARGET_FILE = "LCEWindows64.zip";
const LAUNCHER_REPO = "Jaruwyd/LCE-Launcher";
const SERVER_ZIP_URL = "https://github.com/kuwacom/Minecraft-LegacyConsoleEdition/releases/download/nightly-dedicated-server/LCEServerWindows64.zip";
const SERVER_DIRNAME = "LCEServerWindows64";

let instances = [];
let currentInstanceId = null;
let currentInstance = null;

let releasesData = [];
let commitsData = [];
let currentReleaseIndex = 0;
let isProcessing = false;
let isGameRunning = false;
let gameProcessPid = null;
let gameSessionStart = null;
let gameMonitorInterval = null;
let serverProcessPid = null;
let serverMonitorInterval = null;
let serverProcessName = null;
let serverStopRequestedAt = 0;

// Discord Rich Presence state (sent to main process via IPC).
let rpcCurrentView = 'Play Now';
let rpcPlayStart = null;

let rpcServerStart = null;
function rpcSend(payload) {
    try {
        ipcRenderer.send('rpc-presence', payload);
    } catch (_) {
        // Ignore if IPC isn't available.
    }
}

function rpcSetBrowsing(view) {
    rpcPlayStart = null;
    rpcServerStart = null;
    rpcCurrentView = view || 'Play Now';
    rpcSend({ type: 'browsing', view: rpcCurrentView });
}

function rpcSetPlaying(label, startTimestampMs, extra = {}) {
    rpcCurrentView = rpcCurrentView || 'Play Now';
    rpcPlayStart = startTimestampMs || Date.now();
    rpcSend({ type: 'playing', label: label || 'Legacy (nightly)', startTimestamp: rpcPlayStart, ...extra });
}

function rpcSetHosting(world, maxPlayers, startTimestampMs) {
    rpcCurrentView = rpcCurrentView || 'Play Now';
    rpcServerStart = startTimestampMs || Date.now();
    const payload = {
        type: 'hosting',
        world: world || 'world',
        startTimestamp: rpcServerStart
    };
    const mp = Number(maxPlayers);
    if (Number.isFinite(mp) && mp > 0) payload.maxPlayers = mp;
    // We can't reliably know live player count without parsing server output/protocol.
    // Use "1 / max" as a reasonable placeholder while hosting.
    if (payload.maxPlayers) {
        payload.partySize = 1;
        payload.partyMax = payload.maxPlayers;
    }
    rpcSend(payload);
}


async function getServerRoot() {
    return currentInstance?.serverInstallPath || currentInstance?.installPath || null;
}

async function getServerRpcInfo() {
    try {
        const root = await getServerRoot();
        if (!root) return null;
        const propsPath = await window.__TAURI__.path.join(root, 'server.properties');
        if (!(await safeExists(propsPath))) return null;
        const content = await window.__TAURI__.fs.readTextFile(propsPath);
        const lines = String(content || '').split(/\r?\n/);
        let world = 'world';
        let maxPlayers = null;
        for (const line of lines) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const idx = t.indexOf('=');
            if (idx === -1) continue;
            const key = t.slice(0, idx).trim();
            const val = t.slice(idx + 1).trim();
            if (key === 'level-name' && val) world = val;
            if (key === 'max-players') {
                const n = parseInt(val, 10);
                if (Number.isFinite(n)) maxPlayers = n;
            }
        }
        return { world, maxPlayers };
    } catch (_) {
        return null;
    }
}


async function getDefaultServerInstallDir() {
    const homeDir = await window.__TAURI__.path.homeDir() || "";
    return homeDir ? await window.__TAURI__.path.join(homeDir, 'Documents', SERVER_DIRNAME) : `C:\\${SERVER_DIRNAME}`;
}

function normalizeWindowsPath(p) {
    if (!p || typeof p !== 'string') return null;
    let s = p.trim();
    // Strip wrapping quotes
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
    }
    return s || null;
}

async function validateServerRoot(dir) {
    const root = normalizeWindowsPath(dir);
    if (!root) return { ok: false, root: null, reason: "Server folder not set." };
    // Prevent obviously invalid roots like "\" or "\\" or strings that are only slashes (e.g. "\\\").
    // These can otherwise trigger Windows "cannot find '\\'" dialogs when we try to open/launch.
    const rootNoTrail = root.replace(/[\\/]+$/, "");
    if (!rootNoTrail || rootNoTrail === "\\" || rootNoTrail === "\\\\" || /^[\\/]{2,}$/.test(rootNoTrail)) {
        return { ok: false, root, reason: "Server folder is invalid. Click BROWSE and select the server folder." };
    }
    const exists = await safeExists(root);
    if (!exists) return { ok: false, root, reason: "Server folder does not exist." };
    const serverExe = await window.__TAURI__.path.join(root, 'Minecraft.Server.exe');
    const altServerExe = await window.__TAURI__.path.join(root, 'MinecraftServer.exe');
    const hasServerExe = (await safeExists(serverExe)) || (await safeExists(altServerExe));
    if (!hasServerExe) {
        return { ok: false, root, reason: "Select the folder that contains Minecraft.Server.exe." };
    }
    return { ok: true, root, reason: null };
}

async function isServerInstalledAt(root) {
    const normalized = normalizeWindowsPath(root);
    if (!normalized) return false;
    if (!await safeExists(normalized)) return false;
    const serverExe = await window.__TAURI__.path.join(normalized, 'Minecraft.Server.exe');
    const altServerExe = await window.__TAURI__.path.join(normalized, 'MinecraftServer.exe');
    if (await safeExists(serverExe) || await safeExists(altServerExe)) return true;

    // Some zips may contain a nested folder. Detect common case: <root>\\LCEServerWindows64\\Minecraft.Server.exe
    const nested = await window.__TAURI__.path.join(normalized, SERVER_DIRNAME);
    const nestedExe = await window.__TAURI__.path.join(nested, 'Minecraft.Server.exe');
    const nestedAltExe = await window.__TAURI__.path.join(nested, 'MinecraftServer.exe');
    return (await safeExists(nestedExe)) || (await safeExists(nestedAltExe));
}

async function ensureServerLayout(root) {
    // If the zip extracted into a nested SERVER_DIRNAME folder, move contents up into root.
    const normalized = normalizeWindowsPath(root);
    if (!normalized) return;
    const serverExe = await window.__TAURI__.path.join(normalized, 'Minecraft.Server.exe');
    const altServerExe = await window.__TAURI__.path.join(normalized, 'MinecraftServer.exe');
    if (await safeExists(serverExe) || await safeExists(altServerExe)) return;

    const nested = await window.__TAURI__.path.join(normalized, SERVER_DIRNAME);
    const nestedExe = await window.__TAURI__.path.join(nested, 'Minecraft.Server.exe');
    const nestedAltExe = await window.__TAURI__.path.join(nested, 'MinecraftServer.exe');
    const nestedHasExe = (await safeExists(nestedExe)) || (await safeExists(nestedAltExe));
    if (!nestedHasExe) return;

    const entries = await window.__TAURI__.fs.readDir(nested);
    for (const e of entries) {
        const src = e.path;
        const dest = nodePath.join(normalized, e.name);
        await copyRecursive(src, dest);
    }
    await window.__TAURI__.fs.remove(nested, { recursive: true, force: true });
}

function setServerActionButton(text, disabled = false) {
    const btn = document.getElementById('server-action-btn');
    if (!btn) return;
    btn.textContent = text;
    if (disabled) btn.classList.add('disabled');
    else btn.classList.remove('disabled');
}

async function updateServerActionState() {
    const input = document.getElementById('server-path-input');
    const preferred = (input && typeof input.value === 'string' && input.value.trim()) ? normalizeWindowsPath(input.value) : null;
    const fallback = await getServerRoot();
    const root = preferred || fallback;
    if (!root) {
        setServerActionButton('INSTALL SERVER', false);
        return;
    }
    const installed = await isServerInstalledAt(root);
    setServerActionButton(installed ? 'START SERVER' : 'INSTALL SERVER', false);
}

let snapshotInstanceId = null;

const Store = {
    async get(key, defaultValue) {
        const val = await ipcRenderer.invoke('store_get', { key });
        return (val !== undefined && val !== null) ? val : defaultValue;
    },
    async set(key, value) {
        return await ipcRenderer.invoke('store_set', { key, value });
    },
    async selectDirectory() {
        return await ipcRenderer.invoke('select_directory');
    }
};

const GamepadManager = {
    active: false,
    lastInputTime: 0,
    COOLDOWN: 180,
    loopStarted: false,
    lastAPressed: false,

    init() {
        window.addEventListener("gamepadconnected", () => {
            if (!this.active) {
                this.startLoop();
            }
        });
        this.startLoop();
    },

    startLoop() {
        if (this.loopStarted) return;
        this.loopStarted = true;
        const loop = () => {
            try {
                this.poll();
            } catch (e) {
                console.error("Gamepad poll error:", e);
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    poll() {
        const gamepads = navigator.getGamepads();
        let gp = null;
        for (let i = 0; i < gamepads.length; i++) {
            if (gamepads[i] && gamepads[i].connected && gamepads[i].buttons.length > 0) {
                gp = gamepads[i];
                break;
            }
        }

        if (!gp) {
            if (this.active) {
                this.active = false;
                showToast("Controller Disconnected");
            }
            return;
        }

        if (!this.active) {
            this.active = true;
            showToast("Controller Connected");
            if (!document.activeElement || !document.activeElement.classList.contains('nav-item')) {
                this.focusFirstVisible();
            }
        }

        const now = Date.now();
        const buttons = gp.buttons;
        const axes = gp.axes;

        const isPressed = (idx) => buttons[idx] ? buttons[idx].pressed : false;
        const getAxis = (idx) => axes[idx] !== undefined ? axes[idx] : 0;

        if (now - this.lastInputTime > this.COOLDOWN) {
            const threshold = 0.5;
            const axisX = getAxis(0);
            const axisY = getAxis(1);

            const up = isPressed(12) || axisY < -threshold;
            const down = isPressed(13) || axisY > threshold;
            const left = isPressed(14) || axisX < -threshold;
            const right = isPressed(15) || axisX > threshold;

            if (up) { this.navigate('up'); this.lastInputTime = now; }
            else if (down) { this.navigate('down'); this.lastInputTime = now; }
            else if (left) { this.navigate('left'); this.lastInputTime = now; }
            else if (right) { this.navigate('right'); this.lastInputTime = now; }

            else if (isPressed(4)) { this.cycleActiveSelection(-1); this.lastInputTime = now; }
            else if (isPressed(5)) { this.cycleActiveSelection(1); this.lastInputTime = now; }

            else if (isPressed(1)) { this.cancelCurrent(); this.lastInputTime = now; }

            else if (isPressed(2)) { checkForUpdatesManual(); this.lastInputTime = now; }
        }

        const aPressed = isPressed(0);
        if (aPressed && !this.lastAPressed) {
            this.clickActive();
        }
        this.lastAPressed = aPressed;

        const rStickY = getAxis(3) || getAxis(2) || getAxis(5);
        if (Math.abs(rStickY) > 0.1) {
            this.scrollActive(rStickY * 15);
        }
    },

    focusFirstVisible() {
        const visibleItems = this.getVisibleNavItems();
        if (visibleItems.length > 0) visibleItems[0].focus();
    },

    getVisibleNavItems() {
        const modals = ['update-modal', 'options-modal', 'profile-modal', 'servers-modal', 'instances-modal', 'add-instance-modal', 'skin-modal', 'snapshots-modal'];
        let activeModal = null;
        for (const id of modals) {
            const m = document.getElementById(id);
            if (m && m.style.display === 'flex') {
                activeModal = m;
                break;
            }
        }

        const allItems = Array.from(document.querySelectorAll('.nav-item'));
        return allItems.filter(item => {
            if (activeModal) {
                return activeModal.contains(item) && item.offsetParent !== null;
            }
            let parent = item.parentElement;
            while (parent) {
                if (parent.classList?.contains('modal-overlay') && parent.style.display !== 'flex') return false;
                parent = parent.parentElement;
            }
            return item.offsetParent !== null;
        });
    },

    navigate(direction) {
        const current = document.activeElement;
        const items = this.getVisibleNavItems();

        if (!items.includes(current)) {
            items[0]?.focus();
            return;
        }

        const currentRect = current.getBoundingClientRect();
        const cx = currentRect.left + currentRect.width / 2;
        const cy = currentRect.top + currentRect.height / 2;

        let bestMatch = null;
        let minScore = Infinity;

        items.forEach(item => {
            if (item === current) return;
            const rect = item.getBoundingClientRect();
            const ix = rect.left + rect.width / 2;
            const iy = rect.top + rect.height / 2;

            const dx = ix - cx;
            const dy = iy - cy;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;

            let inDirection = false;
            if (direction === 'right' && angle >= -45 && angle <= 45) inDirection = true;
            if (direction === 'left' && (angle >= 135 || angle <= -135)) inDirection = true;
            if (direction === 'down' && angle > 45 && angle < 135) inDirection = true;
            if (direction === 'up' && angle < -45 && angle > -135) inDirection = true;

            if (inDirection) {
                const distance = Math.sqrt(dx * dx + dy * dy);
                const penalty = (direction === 'left' || direction === 'right') ? Math.abs(dy) * 2.5 : Math.abs(dx) * 2.5;
                const score = distance + penalty;

                if (score < minScore) {
                    minScore = score;
                    bestMatch = item;
                }
            }
        });

        if (bestMatch) {
            bestMatch.focus();
            bestMatch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    },

    clickActive() {
        const active = document.activeElement;
        if (active && active.classList.contains('nav-item')) {
            active.classList.add('active-bump');
            setTimeout(() => active.classList.remove('active-bump'), 100);

            if (active.tagName === 'INPUT' && active.type === 'checkbox') {
                active.checked = !active.checked;
                active.dispatchEvent(new Event('change'));
            } else {
                active.click();
            }
        }
    },

    cancelCurrent() {
        const activeModal = this.getActiveModal();
        if (activeModal) {
            if (activeModal.id === 'options-modal') toggleOptions(false);
            else if (activeModal.id === 'profile-modal') toggleProfile(false);
            else if (activeModal.id === 'servers-modal') toggleServers(false);
            else if (activeModal.id === 'instances-modal') toggleInstances(false);
            else if (activeModal.id === 'add-instance-modal') toggleAddInstance(false);
            else if (activeModal.id === 'info-modal') toggleInfo(false);
            else if (activeModal.id === 'create-server-modal') toggleCreateServer(false);
            else if (activeModal.id === 'update-modal') document.getElementById('btn-skip-update')?.click();
            else if (activeModal.id === 'skin-modal') closeSkinManager();
            else if (activeModal.id === 'snapshots-modal') toggleSnapshots(false);
        }
    },

    getActiveModal() {
        const modals = ['update-modal', 'options-modal', 'profile-modal', 'servers-modal', 'instances-modal', 'add-instance-modal', 'info-modal', 'create-server-modal', 'skin-modal', 'snapshots-modal'];
        for (const id of modals) {
            const m = document.getElementById(id);
            if (m && m.style.display === 'flex') return m;
        }
        return null;
    },

    cycleActiveSelection(dir) {
        const active = document.activeElement;
        if (active && active.id === 'version-select-box') {
            const select = document.getElementById('version-select');
            if (select) {
                let newIdx = select.selectedIndex + dir;
                if (newIdx < 0) newIdx = select.options.length - 1;
                if (newIdx >= select.options.length) newIdx = 0;
                select.selectedIndex = newIdx;
                updateSelectedRelease();
            }
        } else if (active && active.id === 'compat-select-box') {
            const select = document.getElementById('compat-select');
            if (select) {
                let newIdx = select.selectedIndex + dir;
                if (newIdx < 0) newIdx = select.options.length - 1;
                if (newIdx >= select.options.length) newIdx = 0;
                select.selectedIndex = newIdx;
                updateCompatDisplay();
            }
        } else if (!this.getActiveModal()) {
            const select = document.getElementById('version-select');
            if (select) {
                let newIdx = select.selectedIndex + dir;
                if (newIdx < 0) newIdx = select.options.length - 1;
                if (newIdx >= select.options.length) newIdx = 0;
                select.selectedIndex = newIdx;
                updateSelectedRelease();
            }
        }
    },

    scrollActive(val) {
        const serverList = document.getElementById('servers-list-container');
        const instanceList = document.getElementById('instances-list-container');
        const snapshotList = document.getElementById('snapshots-list-container');
        if (this.getActiveModal()?.id === 'servers-modal' && serverList) {
            serverList.scrollTop += val;
        } else if (this.getActiveModal()?.id === 'instances-modal' && instanceList) {
            instanceList.scrollTop += val;
        } else if (this.getActiveModal()?.id === 'snapshots-modal' && snapshotList) {
            snapshotList.scrollTop += val;
        } else if (!this.getActiveModal()) {
            const sidebar = document.getElementById('updates-list')?.parentElement;
            if (sidebar) sidebar.scrollTop += val;
        }
    }
};

const MusicManager = {
    audio: new Audio(),
    playlist: [],
    currentIndex: -1,
    enabled: false,

    async init() {
        this.enabled = await Store.get('legacy_music_enabled', true);
        this.audio.volume = await Store.get('legacy_music_volume', 0.5);
        this.updateIcon();
        this.audio.onended = () => this.playNext();
        if (this.enabled) {
            this.start();
        }

        const slider = document.getElementById('volume-slider');
        if (slider) {
            slider.value = this.audio.volume;
            slider.oninput = async () => {
                this.audio.volume = slider.value;
                await Store.set('legacy_music_volume', this.audio.volume);
            };
        }
    },

    async scan() {
        try {
            const installDir = await getInstallDir();
            if (!installDir) return false;
            const musicPath = await window.__TAURI__.path.join(installDir, 'music', 'music');

            const exists = await safeExists(musicPath);
            if (exists) {
                const entries = await window.__TAURI__.fs.readDir(musicPath);
                this.playlist = [];
                for (const file of entries) {
                    if (file.name.toLowerCase().endsWith('.ogg')) {
                        this.playlist.push(await window.__TAURI__.path.join(musicPath, file.name));
                    }
                }

                for (let i = this.playlist.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [this.playlist[i], this.playlist[j]] = [this.playlist[j], this.playlist[i]];
                }
                return this.playlist.length > 0;
            }
        } catch (e) {
            console.error("Music scan error:", e);
        }
        return false;
    },

    async start() {
        if (this.playlist.length === 0) {
            const success = await this.scan();
            if (!success) return;
        }
        if (this.playlist.length > 0 && this.audio.paused) {
            this.playNext();
        }
    },

    playNext() {
        if (!this.enabled || this.playlist.length === 0) return;

        let nextIndex;
        if (this.playlist.length > 1) {
            do {
                nextIndex = Math.floor(Math.random() * this.playlist.length);
            } while (nextIndex === this.currentIndex);
        } else {
            nextIndex = 0;
        }

        this.currentIndex = nextIndex;
        this.audio.src = window.convertFileSrc(this.playlist[this.currentIndex]);
        this.audio.play().catch(e => {
            console.error("Audio playback error:", e);
            setTimeout(() => this.playNext(), 1000);
        });
    },

    stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
    },

    async toggle() {
        this.enabled = !this.enabled;
        await Store.set('legacy_music_enabled', this.enabled);
        this.updateIcon();
        if (this.enabled) {
            this.start();
        } else {
            this.stop();
        }
    },

    updateIcon() {
        const btn = document.getElementById('music-toggle');
        const icon = document.getElementById('music-icon-ph');
        if (!btn || !icon) return;
        if (this.enabled) {
            btn.classList.remove('muted');
            icon.className = 'ph-bold ph-speaker-high';
        } else {
            btn.classList.add('muted');
            icon.className = 'ph-bold ph-speaker-slash';
        }
    }
};

async function updateSidebarUser() {
    const username = await Store.get('legacy_username', "Player");
    const el = document.getElementById('sidebar-username');
    if (el) el.textContent = username || "Player";
}

async function updateSidebarPlaytime() {
    const playtime = await Store.get('legacy_playtime', 0);
    const el = document.getElementById('playtime-sidebar');
    if (el) {
        el.textContent = formatPlaytime(playtime);
    }
}

function togglePatchNotes() {
    const sidebar = document.getElementById('patch-notes-sidebar');
    const backdrop = document.getElementById('patch-notes-backdrop');
    if (!sidebar) return;
    const nextActive = !sidebar.classList.contains('active');
    sidebar.classList.toggle('active', nextActive);
    if (backdrop) backdrop.classList.toggle('active', nextActive);
}

function showMainView() {
    const patchSidebar = document.getElementById('patch-notes-sidebar');
    const backdrop = document.getElementById('patch-notes-backdrop');
    if (patchSidebar) patchSidebar.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
    if (!isGameRunning) rpcSetBrowsing('Play Now');
}

window.togglePatchNotes = togglePatchNotes;
window.showMainView = showMainView;
window.updateSidebarUser = updateSidebarUser;
window.updateSidebarPlaytime = updateSidebarPlaytime;


async function migrateLegacyConfig() {
    const hasInstances = await Store.get('legacy_instances', null);
    if (!hasInstances) {
        const repo = await Store.get('legacy_repo', DEFAULT_REPO);
        const exec = await Store.get('legacy_exec_path', DEFAULT_EXEC);
        const ip = await Store.get('legacy_ip', "");
        const port = await Store.get('legacy_port', "");
        const isServer = await Store.get('legacy_is_server', false);
        const compat = await Store.get('legacy_compat_layer', 'direct');

        const homeDir = await window.__TAURI__.path.homeDir() || "";
        const defaultInstall = homeDir ? await window.__TAURI__.path.join(homeDir, 'Documents', 'LCEClient') : "C:\\LCEClient";
        const installDir = await Store.get('legacy_install_path', defaultInstall);
        const installedTag = await Store.get('installed_version_tag', null);

        const defaultInstance = {
            id: 'instance-' + Date.now(),
            name: "Default Instance",
            repo: repo,
            execPath: exec,
            ip: ip,
            port: port,
            isServer: isServer,
            compatLayer: compat,
            installPath: installDir,
            installedTag: installedTag
        };

        instances = [defaultInstance];
        currentInstanceId = defaultInstance.id;
        await Store.set('legacy_instances', instances);
        await Store.set('legacy_current_instance_id', currentInstanceId);
    } else {
        instances = hasInstances;
        currentInstanceId = await Store.get('legacy_current_instance_id', instances[0].id);
    }

    currentInstance = instances.find(i => i.id === currentInstanceId) || instances[0];

    if (!currentInstance.installPath) {
        const homeDir = await window.__TAURI__.path.homeDir() || "";
        const fallbackInstall = homeDir ? await window.__TAURI__.path.join(homeDir, 'Documents', 'LCEClient') : "C:\\LCEClient";
        currentInstance.installPath = fallbackInstall;
        await saveInstancesToStore();
    }
    if (!currentInstance.execPath) {
        currentInstance.execPath = DEFAULT_EXEC;
        await saveInstancesToStore();
    }

    // If a previously-saved server path no longer exists (e.g. from another Windows user),
    // clear it so the UI forces the user to browse and pick a valid folder.
    if (currentInstance.serverInstallPath) {
        try {
            const normalized = normalizeWindowsPath(currentInstance.serverInstallPath);
            const exists = normalized ? await safeExists(normalized) : false;
            if (!exists) {
                currentInstance.serverInstallPath = null;
                await saveInstancesToStore();
            }
        } catch (_) {}
    }
}

function setServerPathInputValue(val) {
    const input = document.getElementById('server-path-input');
    if (!input) return;
    input.value = val || "";
    // Ensure the end of long paths is visible (users care about the folder name).
    // Needs a tick so layout happens before we adjust scroll.
    requestAnimationFrame(() => {
        try { input.scrollLeft = input.scrollWidth; } catch (_) {}
    });
}

window.onload = async () => {
    try {
        await migrateLegacyConfig();
        rpcSetBrowsing('Play Now');
        applyNewsFallbackImages();
        loadInfoVersion();
        const bgVideo = document.getElementById('bg-video');
        if (bgVideo) {
            bgVideo.loop = true;
            bgVideo.addEventListener('ended', () => {
                bgVideo.currentTime = 0;
                bgVideo.play().catch(() => {});
            });
        }

        const repoInput = document.getElementById('repo-input');
        const execInput = document.getElementById('exec-input');
        const usernameInput = document.getElementById('username-input');
        const ipInput = document.getElementById('ip-input');
        const portInput = document.getElementById('port-input');
        const serverCheck = document.getElementById('server-checkbox');
        const installInput = document.getElementById('install-path-input');

        if (repoInput) repoInput.value = currentInstance.repo;
        if (execInput) execInput.value = currentInstance.execPath;
        if (usernameInput) usernameInput.value = await Store.get('legacy_username', "");
        if (ipInput) ipInput.value = currentInstance.ip;
        if (portInput) portInput.value = currentInstance.port;
        if (serverCheck) serverCheck.checked = currentInstance.isServer;
        if (installInput) installInput.value = currentInstance.installPath;

        let osType = 'windows';
        try {
            osType = await window.__TAURI__.core.invoke('plugin:os|type') || 'windows';
        } catch (_) {
            osType = 'windows';
        }
        if (osType === 'Linux' || osType === 'Darwin') {
            const compatContainer = document.getElementById('compat-option-container');
            if (compatContainer) {
                compatContainer.style.display = 'block';
                scanCompatibilityLayers();
            }
        } else {
            currentInstance.compatLayer = 'direct';
            await saveInstancesToStore();
        }


        ipcRenderer.on('window-is-maximized', (event, isMaximized) => {
            const btn = document.getElementById('maximize-btn');
            if (btn) btn.textContent = isMaximized ? '❐' : '▢';
        });

        // Initialize features
        fetchGitHubData();
        checkForLauncherUpdates();
        loadSplashText();
        MusicManager.init();
        GamepadManager.init();
        updateSidebarUser();
        updateSidebarPlaytime();

        // Wrap skin manager nav so it updates RPC too (skin_manager.js is loaded before renderer.js).
        if (typeof window.openSkinManager === 'function') {
            const original = window.openSkinManager;
            window.openSkinManager = (...args) => {
                if (!isGameRunning) rpcSetBrowsing('Skins');
                return original(...args);
            };
        }

        setInterval(updateSidebarPlaytime, 60000); // Update sidebar playtime every minute

        window.addEventListener('keydown', (e) => {
            if (e.key === 'F9') {
                checkForLauncherUpdates(true);
            }
        });

        window.addEventListener('online', () => {
            document.getElementById('offline-indicator').style.display = 'none';
            showToast("Back Online! Refreshing...");
            fetchGitHubData();
        });

        window.addEventListener('offline', () => {
            document.getElementById('offline-indicator').style.display = 'block';
            showToast("Connection Lost. Entering Offline Mode.");
        });

        if (!navigator.onLine) {
            document.getElementById('offline-indicator').style.display = 'block';
        }
    } catch (e) {
        console.error("Startup error:", e);
        // Hide loader anyway so user isn't stuck
        const loader = document.getElementById('loader');
        if (loader) loader.style.display = 'none';
        showToast("Error during startup: " + e.message);
    }
};

async function saveInstancesToStore() {
    await Store.set('legacy_instances', instances);
    await Store.set('legacy_current_instance_id', currentInstanceId);
}

async function toggleInstances(show) {
    if (isProcessing) return;
    const modal = document.getElementById('instances-modal');
    if (show) {
        await renderInstancesList();
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
        if (!isGameRunning) rpcSetBrowsing('Installations');
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
        if (!isGameRunning) rpcSetBrowsing('Play Now');
    }
}

async function renderInstancesList() {
    const container = document.getElementById('instances-list-container');
    container.innerHTML = '';

    if (instances.length === 0) {
        container.innerHTML = '<div class="text-center text-gray-400 py-4">No instances found.</div>';
        return;
    }

    instances.forEach((inst) => {
        const isActive = inst.id === currentInstanceId;
        const item = document.createElement('div');
        item.className = `flex justify-between items-center p-4 border-b border-[#333] hover:bg-[#111] ${isActive ? 'bg-[#1a1a1a] border-l-4 border-l-[#55ff55]' : ''}`;

        item.innerHTML = `
            <div class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
                    <span class="text-white text-xl font-bold">${inst.name}</span>
                    ${isActive ? '<span class="text-[10px] bg-[#55ff55] text-black px-1 font-bold">ACTIVE</span>' : ''}
                </div>
                <span class="text-gray-400 text-sm font-mono">${inst.repo}</span>
                <span class="text-gray-500 text-xs">${inst.installPath}</span>
            </div>
            <div class="flex gap-2">
                <div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="openSnapshotsManager('${inst.id}')">BACKUPS</div>
                ${!isActive ? `<div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="switchInstance('${inst.id}')">SWITCH</div>` : ''}
                <div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="deleteInstance('${inst.id}')" style="${isActive ? 'opacity: 0.5; pointer-events: none;' : ''}">DELETE</div>
            </div>
        `;
        container.appendChild(item);
    });
}

function toggleAddInstance(show) {
    const modal = document.getElementById('add-instance-modal');
    if (!modal) {
        showToast("Add Instance UI is missing.");
        return;
    }
    if (show) {
        const nameInput = document.getElementById('new-instance-name');
        const repoInput = document.getElementById('new-instance-repo');
        if (nameInput) nameInput.value = '';
        if (repoInput) repoInput.value = DEFAULT_REPO;
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

function createNewInstance() {
    toggleAddInstance(true);
}

async function saveNewInstance() {
    const nameInput = document.getElementById('new-instance-name');
    const repoInput = document.getElementById('new-instance-repo');
    if (!nameInput || !repoInput) {
        showToast("Add Instance UI is missing.");
        return;
    }
    const name = nameInput.value.trim();
    const repo = repoInput.value.trim() || DEFAULT_REPO;

    if (!name) {
        showToast("Please enter a name for the instance.");
        return;
    }

    const homeDir = await window.__TAURI__.path.homeDir() || "";
    const sanitizedName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const baseDir = homeDir ? await window.__TAURI__.path.join(homeDir, 'Documents') : "C:\\";
    const installPath = await window.__TAURI__.path.join(baseDir, 'LCEClient_' + sanitizedName);

    const newInst = {
        id: 'instance-' + Date.now(),
        name: name,
        repo: repo,
        execPath: DEFAULT_EXEC,
        ip: "",
        port: "",
        isServer: false,
        compatLayer: 'direct',
        installPath: installPath,
        installedTag: null
    };

    instances.push(newInst);
    await saveInstancesToStore();
    toggleAddInstance(false);
    renderInstancesList();
    showToast("Instance Created!");
}

async function switchInstance(id) {
    if (isProcessing || id === currentInstanceId) return;

    currentInstanceId = id;
    currentInstance = instances.find(i => i.id === currentInstanceId);
    await saveInstancesToStore();

    const repoEl = document.getElementById('repo-input');
    const execEl = document.getElementById('exec-input');
    const ipEl = document.getElementById('ip-input');
    const portEl = document.getElementById('port-input');
    const serverEl = document.getElementById('server-checkbox');
    const installEl = document.getElementById('install-path-input');

    if (repoEl) repoEl.value = currentInstance.repo;
    if (execEl) execEl.value = currentInstance.execPath;
    if (ipEl) ipEl.value = currentInstance.ip;
    if (portEl) portEl.value = currentInstance.port;
    if (serverEl) serverEl.checked = currentInstance.isServer;
    if (installEl) installEl.value = currentInstance.installPath;

    if (process.platform === 'linux' || process.platform === 'darwin') {
        scanCompatibilityLayers();
    }

    renderInstancesList();
    showToast("Switched to " + currentInstance.name);
    fetchGitHubData();
    loadSplashText();

    if (window.loadMainMenuSkin) window.loadMainMenuSkin();
}

async function deleteInstance(id) {
    if (id === currentInstanceId) return;

    if (confirm("Are you sure you want to delete this instance profile? (Files on disk will NOT be deleted)")) {
        instances = instances.filter(i => i.id !== id);
        await saveInstancesToStore();
        renderInstancesList();
        showToast("Instance Deleted");
    }
}

async function getInstallDir() {
    return currentInstance.installPath;
}

async function browseInstallDir() {
    const dir = await Store.selectDirectory();
    if (dir) {
        const el = document.getElementById('install-path-input');
        if (el) el.value = dir;
    }
}

async function openGameDir() {
    const dir = await getInstallDir();
    const exists = await safeExists(dir);
    if (exists) {
        await window.__TAURI__.shell.open(dir);
    } else {
        showToast("Directory does not exist yet!");
    }
}

async function getInstalledPath() {
    if (!currentInstance || !currentInstance.installPath || !currentInstance.execPath) {
        console.warn("getInstalledPath: Missing currentInstance details", currentInstance);
        return null;
    }
    return await window.__TAURI__.path.join(currentInstance.installPath, currentInstance.execPath);
}

async function checkIsInstalled(tag) {
    const fullPath = await getInstalledPath();
    const exists = await safeExists(fullPath);
    if (!exists) return false;
    if (!currentInstance.installedTag) {
        currentInstance.installedTag = tag;
        await saveInstancesToStore();
        return true;
    }
    return currentInstance.installedTag === tag;
}

async function updatePlayButtonText() {
    const btn = document.getElementById('btn-play-main');
    if (!btn || isProcessing) return;

    if (isGameRunning) {
        btn.textContent = "GAME RUNNING";
        btn.classList.add('running');
        return;
    } else {
        btn.classList.remove('running');
    }

    // Offline / No Data Case
    if (releasesData.length === 0) {
        const fullPath = await getInstalledPath();
        const exists = await safeExists(fullPath);
        if (currentInstance.installedTag && exists) {
            btn.textContent = "PLAY";
            btn.classList.remove('disabled');
        } else {
            btn.textContent = "OFFLINE";
            btn.classList.add('disabled');
        }
        return;
    }

    const release = releasesData[currentReleaseIndex];
    if (!release) {
        btn.textContent = "PLAY";
        return;
    }

    if (await checkIsInstalled(release.tag_name)) {
        btn.textContent = "PLAY";
    } else {
        const fullPath = await getInstalledPath();
        const exists = await safeExists(fullPath);
        if (exists) {
            btn.textContent = "UPDATE";
        } else {
            btn.textContent = "INSTALL";
        }
    }
}

function setGameRunning(running) {
    isGameRunning = running;
    updatePlayButtonText();
}

async function finalizeGameSession() {
    if (!gameSessionStart) return;
    const sessionDuration = Math.floor((Date.now() - gameSessionStart) / 1000);
    gameSessionStart = null;
    if (sessionDuration <= 0) return;
    const playtime = await Store.get('legacy_playtime', 0);
    await Store.set('legacy_playtime', playtime + sessionDuration);
    updateSidebarPlaytime();
}

function startGameMonitor(pid) {
    if (!pid) return;
    gameProcessPid = pid;
    gameSessionStart = Date.now();
    setGameRunning(true);
    MusicManager.stop();
    { const serverLabel = (currentInstance?.ip ? (currentInstance.port ? `${currentInstance.ip}:${currentInstance.port}` : String(currentInstance.ip)) : 'Singleplayer'); rpcSetPlaying('Legacy (nightly)', gameSessionStart, { server: serverLabel, partySize: 1, partyMax: currentInstance?.ip ? undefined : 1 }); }

    if (gameMonitorInterval) clearInterval(gameMonitorInterval);
    gameMonitorInterval = setInterval(async () => {
        if (!gameProcessPid) return;
        let running = true;
        try {
            process.kill(gameProcessPid, 0);
        } catch (_) {
            running = false;
        }
        if (!running) {
            clearInterval(gameMonitorInterval);
            gameMonitorInterval = null;
            gameProcessPid = null;
            await finalizeGameSession();
            setGameRunning(false);
            rpcSetBrowsing(rpcCurrentView || 'Play Now');
            if (MusicManager.enabled) MusicManager.start();
        }
    }, 3000);
}

function isWindowsProcessRunning(imageName) {
    return new Promise((resolve) => {
        if (!imageName) return resolve(false);
        childProcess.exec(`tasklist /FI "IMAGENAME eq ${imageName}" /NH`, (err, stdout) => {
            if (err) return resolve(false);
            resolve(stdout && stdout.toLowerCase().includes(imageName.toLowerCase()));
        });
    });
}

function startServerMonitor(pid, imageName = null) {
    serverProcessPid = pid || null;
    serverProcessName = imageName || null;
    if (serverMonitorInterval) clearInterval(serverMonitorInterval);
    serverMonitorInterval = setInterval(async () => {
        let running = true;
        if (serverProcessPid) {
            try { process.kill(serverProcessPid, 0); } catch { running = false; }
        } else if (process.platform === 'win32' && serverProcessName) {
            running = await isWindowsProcessRunning(serverProcessName);
        } else {
            running = false;
        }

        if (!running) {
            clearInterval(serverMonitorInterval);
            serverMonitorInterval = null;
            serverProcessPid = null;
            serverProcessName = null;
            showToast("Server stopped.");
        }
    }, 2500);
}

function minimizeWindow() {
    ipcRenderer.send('window-minimize');
}

function toggleMaximize() {
    ipcRenderer.send('window-maximize');
}

function closeWindow() {
    ipcRenderer.send('window-close');
}

async function fetchGitHubData() {
    const repo = getRepoSlug(currentInstance.repo);
    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const offlineInd = document.getElementById('offline-indicator');

    if (loader) loader.style.display = 'flex';
    if (loaderText) loaderText.textContent = "SYNCING: " + repo;

    const hideLoader = () => {
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => { loader.style.display = 'none'; }, 300);
        }
    };

    if (!navigator.onLine) {
        console.log("Offline detected, skipping GitHub sync.");
        if (offlineInd) offlineInd.style.display = 'block';
        handleOfflineData();
        setTimeout(hideLoader, 500);
        return;
    }

    try {
        const [releases, commits] = await Promise.all([
            httpFetchJson(`https://api.github.com/repos/${repo}/releases`),
            httpFetchJson(`https://api.github.com/repos/${repo}/commits`)
        ]);

        releasesData = releases;
        commitsData = commits;

        populateVersions();
        populateUpdatesSidebar();

        setTimeout(hideLoader, 500);
    } catch (err) {
        console.error("Fetch error:", err);
        if (loaderText) loaderText.textContent = "API Error: " + err.message;

        handleOfflineData();

        showToast("Entering Offline Mode.");
        if (offlineInd) offlineInd.style.display = 'block';
        setTimeout(hideLoader, 3500);
    }
}

function handleOfflineData() {
    releasesData = [];
    commitsData = [];
    populateVersions();
    populateUpdatesSidebar();
}

function populateVersions() {
    const select = document.getElementById('version-select');
    const display = document.getElementById('current-version-display');
    if (!select) return;
    select.innerHTML = '';

    if (releasesData.length === 0) {
        // Check if we have a local version installed
        if (currentInstance.installedTag) {
            const opt = document.createElement('option');
            opt.value = 0;
            opt.textContent = `Installed (${currentInstance.installedTag})`;
            select.appendChild(opt);
            if (display) display.textContent = opt.textContent;
        } else {
            if (display) display.textContent = "No Connection / No Install";
        }
        updatePlayButtonText();
        return;
    }

    releasesData.forEach((rel, index) => {
        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = `Legacy (${rel.tag_name})`;
        select.appendChild(opt);
        if (index === 0 && display) display.textContent = opt.textContent;
    });
    currentReleaseIndex = 0;
    updatePlayButtonText();
}

function populateUpdatesSidebar() {
    const list = document.getElementById('updates-list');
    const announcements = document.getElementById('announcements-list');
    if (list) list.innerHTML = '';
    if (announcements) announcements.innerHTML = '';

    if (commitsData.length === 0) {
        const empty = '<div class="update-item">No recent activity found.</div>';
        if (list) list.innerHTML = empty;
        if (announcements) announcements.innerHTML = empty;
        applyNewsFallbackImages();
        const news1Title = document.getElementById('news-title-1');
        const news1Tag = document.getElementById('news-tag-1');
        const news3Title = document.getElementById('news-title-3');
        const news3Tag = document.getElementById('news-tag-3');
        if (news1Title) news1Title.textContent = "No recent updates";
        if (news1Tag) news1Tag.textContent = "LATEST UPDATE";
        if (news3Title) news3Title.textContent = "Check connection or repo";
        if (news3Tag) news3Tag.textContent = "PATCH NOTE";
        return;
    }

    // Update Main Page News Cards
    const news1Title = document.getElementById('news-title-1');
    const news1Tag = document.getElementById('news-tag-1');
    const news3Title = document.getElementById('news-title-3');
    const news3Tag = document.getElementById('news-tag-3');

    if (commitsData[0]) {
        if (news1Title) news1Title.textContent = commitsData[0].commit.message.split('\n')[0];
        if (news1Tag) news1Tag.textContent = "LATEST PATCH: #" + commitsData[0].sha.substring(0, 7);
    }
    if (commitsData[1]) {
        if (news3Title) news3Title.textContent = commitsData[1].commit.message.split('\n')[0];
        if (news3Tag) news3Tag.textContent = "PREVIOUS PATCH: #" + commitsData[1].sha.substring(0, 7);
    }

    commitsData.slice(0, 20).forEach((c) => {
        const item = document.createElement('div');
        item.className = 'update-item patch-note-card commit-card';
        const date = new Date(c.commit.author.date).toLocaleString();
        const shortSha = c.sha.substring(0, 7);
        const message = c.commit.message;
        item.innerHTML = `
            <div class="pn-header">
                <span class="update-date">${date}</span>
                <span class="commit-sha">#${shortSha}</span>
            </div>
            <div class="pn-body commit-msg">${message}</div>
        `;
        if (list) list.appendChild(item.cloneNode(true));
        if (announcements) announcements.appendChild(item);
    });
}

function updateSelectedRelease() {
    const select = document.getElementById('version-select');
    if (!select) return;
    currentReleaseIndex = select.value;
    const display = document.getElementById('current-version-display');
    if (display && select.options[select.selectedIndex]) {
        display.textContent = select.options[select.selectedIndex].text;
    }
    updatePlayButtonText();
}

async function launchGame() {
    if (isProcessing || isGameRunning) return;

    if (!navigator.onLine || releasesData.length === 0) {
        const fullPath = await getInstalledPath();
        const exists = await safeExists(fullPath);
        if (currentInstance.installedTag && exists) {
            setProcessingState(true);
            updateProgress(100, "Offline Launch...");
            await launchLocalClient();
            setProcessingState(false);
        } else {
            showToast("You need an internet connection to install the game!");
        }
        return;
    }

    const release = releasesData[currentReleaseIndex];
    if (!release) return;
    const asset = release.assets.find(a => a.name === TARGET_FILE);
    if (!asset) {
        showToast("ZIP Asset missing in this version!");
        return;
    }
    const isInstalled = await checkIsInstalled(release.tag_name);
    if (isInstalled) {
        setProcessingState(true);
        updateProgress(100, "Launching...");
        await launchLocalClient();
        setProcessingState(false);
    } else {
        const fullPath = await getInstalledPath();
        const exists = await safeExists(fullPath);
        if (exists) {
            const choice = await promptUpdate(release.tag_name);
            if (choice === 'update') {
                setProcessingState(true);
                await handleElectronFlow(asset.browser_download_url);
                setProcessingState(false);
            } else if (choice === 'launch') {
                setProcessingState(true);
                updateProgress(100, "Launching Existing...");
                await launchLocalClient();
                setProcessingState(false);
            }
        } else {
            setProcessingState(true);
            await handleElectronFlow(asset.browser_download_url);
            setProcessingState(false);
        }
    }
    updatePlayButtonText();
}

async function promptUpdate(newTag) {
    return new Promise(async (resolve) => {
        const modal = document.getElementById('update-modal');
        const confirmBtn = document.getElementById('btn-confirm-update');
        const skipBtn = document.getElementById('btn-skip-update');
        const closeBtn = document.getElementById('btn-close-update');
        const modalText = document.getElementById('update-modal-text');
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
        const cleanup = (result) => {
            modal.style.opacity = '0';
            setTimeout(() => {
                modal.style.display = 'none';
                if (modalText) modalText.style.display = 'none';
            }, 300);
            confirmBtn.onclick = null;
            skipBtn.onclick = null;
            closeBtn.onclick = null;
            resolve(result);
        };
        confirmBtn.onclick = () => cleanup('update');
        skipBtn.onclick = () => cleanup('launch');
        closeBtn.onclick = () => cleanup('cancel');
    });
}

async function checkForUpdatesManual() {
    const rel = releasesData[currentReleaseIndex];
    if (!rel) {
        showToast("No releases loaded yet");
        return;
    }
    const asset = rel.assets.find(a => a.name === TARGET_FILE);
    if (!asset) {
        showToast("ZIP Asset missing in this version!");
        return;
    }
    const choice = await promptUpdate(rel.tag_name);
    if (choice === 'update') {
        setProcessingState(true);
        await handleElectronFlow(asset.browser_download_url);
        setProcessingState(false);
    } else if (choice === 'launch') {
        setProcessingState(true);
        updateProgress(100, "Launching Existing...");
        await launchLocalClient();
        setProcessingState(false);
    }
    updatePlayButtonText();
}

async function launchLocalClient() {
    const fullPath = await getInstalledPath();
    const exists = await safeExists(fullPath);
    if (!exists) throw new Error("Executable not found! Try reinstalling.");
    if (process.platform !== 'win32') {
        try { fs.chmodSync(fullPath, 0o755); } catch (e) { console.warn("Failed to set executable permissions:", e); }
    }
    return new Promise(async (resolve, reject) => {
        const username = await Store.get('legacy_username', "");
        const ip = currentInstance.ip;
        const port = currentInstance.port;
        const isServer = currentInstance.isServer;
        let args = [];
        if (username) args.push("-name", username);
        if (isServer) args.push("-server");
        if (ip) args.push("-ip", ip);
        if (port) args.push("-port", port);

        const compat = currentInstance.compatLayer === 'direct' ? null : currentInstance.compatLayer;

        try {
            const pid = await window.__TAURI__.core.invoke('run_game', {
                execPath: fullPath,
                args: args,
                compatLayer: compat
            });

            startGameMonitor(pid);
            console.log("Game started with PID:", pid);
            resolve();
        } catch (e) {
            showToast("Failed to launch: " + e);
            reject(e);
        }
    });
}

async function launchServer() {
    if (isProcessing) {
        showToast("Please wait for the current task to finish.");
        return;
    }
    if (serverProcessPid) {
        showToast("Server already running.");
        return;
    }

    // Prefer the value currently visible in the UI so manual edits take effect immediately.
    // Do not save until it's validated; otherwise we can persist a bad/partial path.
    const serverPathInput = document.getElementById('server-path-input');
    const preferredRoot =
        (serverPathInput && typeof serverPathInput.value === 'string' && serverPathInput.value.trim())
            ? normalizeWindowsPath(serverPathInput.value)
            : null;

    const fallbackRoot = await getServerRoot();
    if (!preferredRoot && !fallbackRoot) {
        showToast("Select your server folder first (click BROWSE).");
        return;
    }
    const { ok, root: serverRoot, reason } = await validateServerRoot(preferredRoot || fallbackRoot);
    if (!ok) {
        showToast(reason + (preferredRoot ? ` (${preferredRoot})` : ""));
        return;
    }

    // Persist the validated root so future opens/launches are consistent.
    currentInstance.serverInstallPath = serverRoot;
    await saveInstancesToStore();

    const compat = currentInstance.compatLayer === 'direct' ? null : currentInstance.compatLayer;

    // There are 2 common server start modes in these builds:
    // 1) Dedicated server binary: Minecraft.Server.exe (should NOT need -server)
    // 2) Client binary started as server: Minecraft.Client.exe -server
    const dedicatedServerExe = await window.__TAURI__.path.join(serverRoot, 'Minecraft.Server.exe');
    const altDedicatedServerExe = await window.__TAURI__.path.join(serverRoot, 'MinecraftServer.exe');
    const clientServerExe = await window.__TAURI__.path.join(serverRoot, 'Minecraft.Client.exe');

    let execPath = null;
    let args = [];

    if (await safeExists(dedicatedServerExe)) {
        execPath = dedicatedServerExe;
        args = [];
    } else if (await safeExists(altDedicatedServerExe)) {
        execPath = altDedicatedServerExe;
        args = [];
    } else if (await safeExists(clientServerExe)) {
        execPath = clientServerExe;
        args = ['-server'];
    }

    if (!execPath) {
        showToast("Server executable not found. Put Minecraft.Server.exe (or Minecraft.Client.exe) in the selected server folder.");
        return;
    }
    if (!await safeExists(execPath)) {
        showToast("Server executable path is invalid.");
        return;
    }
    try {
        await ensureServerWorldDir();

        if (process.platform === 'win32') {
            const imageName = nodePath.basename(execPath);

            showToast(`Starting server from: ${serverRoot}`);

            // Important: launching a console EXE from Electron can look like "nothing happened" if no window is shown.
            // Also, our old "SmartScreen blocked" toast was a guess based on tasklist. Instead:
            // - Launch via PowerShell Start-Process -PassThru so we can get a PID or an actual error message.
            // - Do NOT hide the window; if SmartScreen wants to prompt, it must be visible.
            const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
            const psArgList = args.length ? ` -ArgumentList @(${args.map(a => psQuote(a)).join(', ')})` : '';
            const psCmd =
                `$ErrorActionPreference='Stop'; ` +
                `try { ` +
                `  $p = Start-Process -FilePath ${psQuote(execPath)} -WorkingDirectory ${psQuote(serverRoot)}${psArgList} -PassThru; ` +
                `  Start-Sleep -Milliseconds 150; ` +
                `  Write-Output $p.Id; ` +
                `} catch { ` +
                `  Write-Output ('ERROR: ' + $_.Exception.Message); exit 1; ` +
                `}`;

            childProcess.execFile(
                'powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
                { windowsHide: false, timeout: 15000 },
                async (err, stdout, stderr) => {
                    const out = String(stdout || "").trim();
                    const errOut = String(stderr || "").trim();

                    if (err || out.startsWith('ERROR:')) {
                        const msg = out.startsWith('ERROR:') ? out.slice('ERROR:'.length).trim() : (err?.message || "Unknown error");
                        // Common case: SmartScreen / Windows Defender blocks execution with no clear UI.
                        showToast(`Server failed to start: ${msg || errOut || "Blocked by Windows? Try running Minecraft.Server.exe once manually (More info -> Run anyway), then try again."}`);
                        return;
                    }

                    const pid = parseInt(out, 10);
                    if (Number.isFinite(pid) && pid > 0) {
                        startServerMonitor(pid, null);
                        showToast("Server started.");
                        getServerRpcInfo().then((info) => {
                            if (info) rpcSetHosting(info.world, info.maxPlayers, Date.now());
                            else rpcSetHosting('world', null, Date.now());
                        });
                        return;
                    }

                    // If we didn't get a PID, fall back to image-name monitoring.
                    startServerMonitor(null, imageName);
                    const running = await isWindowsProcessRunning(imageName);
                    if (!running) {
                        showToast("Server didn't start. Try running Minecraft.Server.exe once manually, then click START SERVER again.");
                    } else {
                        showToast("Server started.");
                        getServerRpcInfo().then((info) => {
                            if (info) rpcSetHosting(info.world, info.maxPlayers, Date.now());
                            else rpcSetHosting('world', null, Date.now());
                        });
                    }
                }
            );

            // We now show completion based on the execFile callback.
            return;
        }

        const pid = await window.__TAURI__.core.invoke('run_game', {
            execPath: execPath,
            args: args,
            compatLayer: compat,
            cwd: serverRoot
        });
        startServerMonitor(pid, null);
        showToast("Server starting...");
    } catch (e) {
        showToast("Failed to start server: " + (e?.message || e));
    }
}

async function stopServer() {
    if (!serverProcessPid && !serverProcessName) {
        showToast("No server running.");
        return;
    }

    // On Windows, prefer a graceful shutdown by sending "/stop" into the server console window.
    // If that doesn't work (no console window / focus blocked), the user can press STOP again to force-kill.
    try {
        if (process.platform === 'win32') {
            const now = Date.now();
            const force = serverStopRequestedAt && (now - serverStopRequestedAt) < 12000;

            if (!force && serverProcessPid) {
                serverStopRequestedAt = now;
                const psCmd =
                    `$ErrorActionPreference='Stop'; ` +
                    `$serverPid=${serverProcessPid}; ` +
                    `try { ` +
                    `  $ws = New-Object -ComObject WScript.Shell; ` +
                    `  $ok = $ws.AppActivate($serverPid); ` +
                    `  if (-not $ok) { throw 'Could not focus server window (try clicking it once).'; } ` +
                    `  Start-Sleep -Milliseconds 120; ` +
                    `  $ws.SendKeys('/stop{ENTER}'); ` +
                    `  Write-Output 'OK'; ` +
                    `} catch { Write-Output ('ERROR: ' + $_.Exception.Message); exit 1 }`;

                childProcess.execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true }, (err, stdout) => {
                    const out = String(stdout || "").trim();
                    if (err || out.startsWith('ERROR:')) {
                        const msg = out.startsWith('ERROR:') ? out.slice('ERROR:'.length).trim() : (err?.message || "Unknown error");
                        showToast(`Couldn't send /stop automatically: ${msg}. Click the server window and type /stop, or press STOP SERVER again to force close.`);
                    } else {
                        showToast("Sent /stop. Saving world...");
                    }
                });
            } else {
                // Force kill (2nd press within 12s, or no PID available).
                serverStopRequestedAt = 0;
                if (serverProcessPid) childProcess.exec(`taskkill /PID ${serverProcessPid} /T /F`);
                else if (serverProcessName) childProcess.exec(`taskkill /IM ${serverProcessName} /T /F`);
                showToast("Force stopping server...");
            }
        } else {
            process.kill(serverProcessPid, 'SIGTERM');
        }
    } catch (e) {
        showToast("Failed to stop server: " + (e?.message || e));
        return;
    }

    // Wait briefly; if it doesn't exit, tell the user to use /stop in the server console.
    const pidToWait = serverProcessPid;
    const start = Date.now();
    const waitMs = 12000;
    while (Date.now() - start < waitMs) {
        await new Promise(r => setTimeout(r, 400));
        let running = true;
        if (pidToWait) {
            try { process.kill(pidToWait, 0); } catch { running = false; }
        } else if (process.platform === 'win32' && serverProcessName) {
            running = await isWindowsProcessRunning(serverProcessName);
        } else {
            running = false;
        }
        if (!running) break;
    }

    if (serverMonitorInterval) {
        clearInterval(serverMonitorInterval);
        serverMonitorInterval = null;
    }

    // If still running, don't force-kill by default (it can lose saves).
    let stillRunning = true;
    if (pidToWait) {
        try { process.kill(pidToWait, 0); } catch { stillRunning = false; }
    } else if (process.platform === 'win32' && serverProcessName) {
        stillRunning = await isWindowsProcessRunning(serverProcessName);
    } else {
        stillRunning = false;
    }
    if (stillRunning) {
        if (process.platform === 'win32') {
            showToast("Server still running. If you didn't see it close, click the server window and type /stop. Press STOP SERVER again to force close.");
        } else {
            showToast("Server still running. Use /stop in the server console to save & quit.");
        }
        return;
    }

    serverProcessPid = null;
    serverProcessName = null;
    serverStopRequestedAt = 0;
    showToast("Server stopped.");
}

async function getServerPropertiesPath() {
    const root = await getServerRoot();
    if (!root) return null;
    return await window.__TAURI__.path.join(root, 'server.properties');
}

async function ensureServerWorldDir() {
    const root = await getServerRoot();
    if (!root) return;
    const propsPath = await getServerPropertiesPath();
    const gameHddDir = await window.__TAURI__.path.join(root, 'Windows64', 'GameHDD');

    let levelName = 'world';
    try {
        if (propsPath && await safeExists(propsPath)) {
            const content = await window.__TAURI__.fs.readTextFile(propsPath);
            const match = content.match(/^\s*level-name\s*=\s*(.+)\s*$/im);
            if (match) levelName = match[1].trim() || levelName;
        }
    } catch (_) {}

    try {
        if (!await safeExists(gameHddDir)) {
            await window.__TAURI__.fs.mkdir(gameHddDir, { recursive: true });
        }
        const worldDir = await window.__TAURI__.path.join(gameHddDir, levelName);
        if (!await safeExists(worldDir)) {
            await window.__TAURI__.fs.mkdir(worldDir, { recursive: true });
        }
    } catch (e) {
        console.error('Failed to ensure server world dir:', e);
    }
}

async function loadServerSettings() {
    const mappings = [
        { key: 'gamertags', id: 'server-gamertags-toggle' },
        { key: 'pvp', id: 'server-pvp-toggle' },
        { key: 'fire-spreads', id: 'server-fire-spread-toggle' },
        { key: 'tnt', id: 'server-tnt-toggle' },
        { key: 'trust-players', id: 'server-trust-players-toggle' },
        { key: 'generate-structures', id: 'server-structures-toggle' }
    ];
    const maxPlayersInput = document.getElementById('server-max-players-input');
    const filePath = await getServerPropertiesPath();
    if (!filePath) return;
    const exists = await safeExists(filePath);
    if (!exists) {
        mappings.forEach((m) => {
            const el = document.getElementById(m.id);
            if (el) el.checked = false;
        });
        if (maxPlayersInput) maxPlayersInput.value = "";
        return;
    }
    try {
        const content = await window.__TAURI__.fs.readTextFile(filePath);
        mappings.forEach((m) => {
            const el = document.getElementById(m.id);
            if (!el) return;
            const regex = new RegExp(`^\\s*${m.key}\\s*=\\s*(.+)\\s*$`, 'im');
            const match = content.match(regex);
            if (match) {
                const val = match[1].trim().toLowerCase();
                el.checked = val === 'true' || val === 'on' || val === '1' || val === 'yes';
            }
        });
        if (maxPlayersInput) {
            const match = content.match(/^\s*max-players\s*=\s*(.+)\s*$/im);
            if (match) {
                maxPlayersInput.value = match[1].trim();
            }
        }
    } catch (e) {
        console.error('Failed to load server.properties:', e);
    }
}

async function saveServerSetting(key, enabled) {
    const filePath = await getServerPropertiesPath();
    if (!filePath) return;
    const exists = await safeExists(filePath);
    if (!exists) {
        showToast("Start the server once to create server.properties.");
        return;
    }
    try {
        const content = await window.__TAURI__.fs.readTextFile(filePath);
        const lines = content.split(/\r?\n/);
        const value = enabled ? 'true' : 'false';
        let found = false;
        const nextLines = lines.map((line) => {
            if (line.trim().startsWith(`${key}=`)) {
                found = true;
                return `${key}=${value}`;
            }
            return line;
        });
        if (!found) nextLines.push(`${key}=${value}`);
        await window.__TAURI__.fs.writeTextFile(filePath, nextLines.join('\n'));
        showToast(`${key} set to ${value}.`);
    } catch (e) {
        showToast("Failed to update server.properties.");
        console.error('Failed to save server setting:', e);
    }
}

async function saveServerNumberSetting(key, value) {
    const filePath = await getServerPropertiesPath();
    if (!filePath) return;
    const exists = await safeExists(filePath);
    if (!exists) {
        showToast("Start the server once to create server.properties.");
        return;
    }
    const numeric = Math.max(1, Math.min(99, Number(value) || 1));
    try {
        const content = await window.__TAURI__.fs.readTextFile(filePath);
        const lines = content.split(/\r?\n/);
        let found = false;
        const nextLines = lines.map((line) => {
            if (line.trim().startsWith(`${key}=`)) {
                found = true;
                return `${key}=${numeric}`;
            }
            return line;
        });
        if (!found) nextLines.push(`${key}=${numeric}`);
        await window.__TAURI__.fs.writeTextFile(filePath, nextLines.join('\n'));
        showToast(`${key} set to ${numeric}.`);
    } catch (e) {
        showToast("Failed to update server.properties.");
        console.error('Failed to save server number setting:', e);
    }
}

async function installServer() {
    if (isProcessing) {
        showToast("Please wait for the current task to finish.");
        return;
    }

    const input = document.getElementById('server-path-input');
    let targetRoot = (input && typeof input.value === 'string' && input.value.trim())
        ? normalizeWindowsPath(input.value)
        : null;
    if (!targetRoot) targetRoot = await getDefaultServerInstallDir();

    setServerPathInputValue(targetRoot);

    // Basic sanity: avoid weird roots.
    const rootNoTrail = targetRoot.replace(/[\\/]+$/, "");
    if (!rootNoTrail || rootNoTrail === "\\" || rootNoTrail === "\\\\" || /^[\\/]{2,}$/.test(rootNoTrail)) {
        showToast("Pick a valid folder for the server (click BROWSE).");
        return;
    }

    setProcessingState(true);
    updateProgress(5, "Downloading Server...");
    try {
        await window.__TAURI__.fs.mkdir(targetRoot, { recursive: true });

        // Preserve common server configs/world folder between updates.
        const preserveList = [
            'server.properties',
            'whitelist.json',
            'banned-ips.json',
            'banned-players.json',
            'Windows64/GameHDD'
        ];

        await window.__TAURI__.core.invoke('download_and_extract', {
            url: SERVER_ZIP_URL,
            extractDir: targetRoot,
            preserveList
        });

        await ensureServerLayout(targetRoot);

        const installed = await isServerInstalledAt(targetRoot);
        if (!installed) {
            throw new Error("Install finished but Minecraft.Server.exe wasn't found. Try selecting the extracted folder manually.");
        }

        currentInstance.serverInstallPath = targetRoot;
        await saveInstancesToStore();
        loadServerSettings();
        await updateServerActionState();

        updateProgress(100, "Server Installed");
        showToast("Server installed. Click START SERVER.");
    } catch (e) {
        console.error("Server install failed:", e);
        showToast("Server install failed: " + (e?.message || e));
    } finally {
        setProcessingState(false);
    }
}

async function serverAction() {
    const input = document.getElementById('server-path-input');
    const preferred = (input && typeof input.value === 'string' && input.value.trim()) ? normalizeWindowsPath(input.value) : null;
    const fallback = await getServerRoot();
    const root = preferred || fallback;
    const installed = root ? await isServerInstalledAt(root) : false;
    if (installed) return launchServer();
    return installServer();
}

async function browseServerDir() {
    const dir = await Store.selectDirectory();
    if (!dir) return;
    const { ok, root, reason } = await validateServerRoot(dir);
    setServerPathInputValue(normalizeWindowsPath(dir) || dir);
    if (!ok) { showToast(reason); return; }
    currentInstance.serverInstallPath = root;
    await saveInstancesToStore();
    setServerPathInputValue(root);
    showToast("Server folder updated.");
    loadServerSettings();
    await updateServerActionState();
}

async function setServerDir(dir) {
    const next = normalizeWindowsPath(dir);
    if (!next) return;
    const { ok, root, reason } = await validateServerRoot(next);
    if (!ok) { showToast(reason); return; }
    currentInstance.serverInstallPath = root;
    await saveInstancesToStore();
}

async function openServerDir() {
    // Prefer the value currently visible in the UI so manual edits take effect immediately.
    // Do not save until it's validated; otherwise we can persist a bad/partial path.
    const serverPathInput = document.getElementById('server-path-input');
    const preferredRoot =
        (serverPathInput && typeof serverPathInput.value === 'string' && serverPathInput.value.trim())
            ? normalizeWindowsPath(serverPathInput.value)
            : null;

    const fallbackRoot = await getServerRoot();
    if (!preferredRoot && !fallbackRoot) {
        showToast("Select your server folder first (click BROWSE).");
        return;
    }
    const { ok, root, reason } = await validateServerRoot(preferredRoot || fallbackRoot);
    if (!ok) { showToast(reason); return; }
    currentInstance.serverInstallPath = root;
    await saveInstancesToStore();
    const result = await window.__TAURI__.shell.open(root);
    if (typeof result === 'string' && result) {
        showToast("Failed to open folder: " + result);
    }
}

function setProcessingState(active) {
    isProcessing = active;
    const playBtn = document.getElementById('btn-play-main');
    const overlay = document.getElementById('launch-overlay');
    if (active) {
        if (playBtn) playBtn.classList.add('disabled');
        if (overlay) overlay.style.display = 'flex';
        updateProgress(0, "Preparing...");
    } else {
        if (playBtn) playBtn.classList.remove('disabled');
        if (overlay) overlay.style.display = 'none';
    }
}

function updateProgress(percent, text) {
    const bar = document.getElementById('progress-fill');
    if (bar) bar.style.width = percent + "%";
    const txt = document.getElementById('progress-text-overlay');
    if (text && txt) txt.textContent = text;
}

async function handleElectronFlow(url) {
    try {
        const extractDir = currentInstance.installPath;
        const preserveList = ['options.txt', 'servers.txt', 'username.txt', 'settings.dat', 'UID.dat', 'Windows64/GameHDD', 'Common/res/mob/char.png'];

        updateProgress(5, "Downloading & Extracting...");

        await window.__TAURI__.core.invoke('download_and_extract', {
            url: url,
            extractDir: extractDir,
            preserveList: preserveList
        });

        await MusicManager.scan();
        if (MusicManager.enabled) MusicManager.start();

        const fullPath = await getInstalledPath();
        updateProgress(100, "Launching...");
        currentInstance.installedTag = releasesData[currentReleaseIndex].tag_name;
        await saveInstancesToStore();
        await new Promise(r => setTimeout(r, 800));
        await launchLocalClient();
    } catch (e) {
        showToast("Error: " + (e?.message || e));
        console.error(e);
    }
}

async function downloadFile(url, destPath) {
    try {
        await window.__TAURI__.core.invoke('download_file', { url, destPath });
    } catch (e) {
        throw new Error("Download Failed: " + e);
    }
}

function toggleOptions(show) {
    if (isProcessing) return;
    const modal = document.getElementById('options-modal');
    if (show) { document.activeElement?.blur(); modal.style.display = 'flex'; modal.style.opacity = '1'; }
    else { modal.style.opacity = '0'; setTimeout(() => modal.style.display = 'none', 300); }
    if (!isGameRunning) rpcSetBrowsing(show ? 'Settings' : 'Play Now');
}

async function toggleProfile(show) {
    if (isProcessing) return;
    const modal = document.getElementById('profile-modal');
    if (show) { await updatePlaytimeDisplay(); document.activeElement?.blur(); modal.style.display = 'flex'; modal.style.opacity = '1'; }
    else { modal.style.opacity = '0'; setTimeout(() => modal.style.display = 'none', 300); }
}

function toggleInfo(show) {
    if (isProcessing) return;
    const modal = document.getElementById('info-modal');
    if (!modal) return;
    if (show) { document.activeElement?.blur(); modal.style.display = 'flex'; modal.style.opacity = '1'; }
    else { modal.style.opacity = '0'; setTimeout(() => modal.style.display = 'none', 300); }
    if (!isGameRunning) rpcSetBrowsing(show ? 'Info' : 'Play Now');
}

function toggleCreateServer(show) {
    if (isProcessing) return;
    const modal = document.getElementById('create-server-modal');
    if (!modal) return;
    if (show) {
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
        (async () => {
            const root = await getServerRoot();
            setServerPathInputValue(root || "");
            await updateServerActionState();
        })();
        loadServerSettings();
        if (!isGameRunning) rpcSetBrowsing('Create Server');
    }
    else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
        if (!isGameRunning) rpcSetBrowsing('Play Now');
    }
}

async function toggleServers(show) {
    if (isProcessing) return;
    const modal = document.getElementById('servers-modal');
    if (show) {
        await loadServers();
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
        if (!isGameRunning) rpcSetBrowsing('Servers');
    }
    else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
        if (!isGameRunning) rpcSetBrowsing('Play Now');
    }
}

function toggleAnnouncements(show) {
    const modal = document.getElementById('announcements-modal');
    if (!modal) return;
    if (show) {
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

window.toggleAnnouncements = toggleAnnouncements;

async function getServersFilePath() { return await window.__TAURI__.path.join(currentInstance.installPath, 'servers.txt'); }

async function loadServers() {
    const filePath = await getServersFilePath();
    const container = document.getElementById('servers-list-container');
    if (!container) return;
    container.innerHTML = '';
    const exists = await safeExists(filePath);
    if (!exists) { container.innerHTML = '<div class="text-center text-gray-400 py-4">No servers added yet.</div>'; return; }
    try {
        const content = await window.__TAURI__.fs.readTextFile(filePath);
        const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '');
        const servers = [];
        for (let i = 0; i < lines.length; i += 3) { if (lines[i] && lines[i + 1] && lines[i + 2]) servers.push({ ip: lines[i], port: lines[i + 1], name: lines[i + 2] }); }
        if (servers.length === 0) { container.innerHTML = '<div class="text-center text-gray-400 py-4">No servers added yet.</div>'; return; }
        servers.forEach((s, index) => {
            const item = document.createElement('div');
            item.className = 'flex justify-between items-center p-3 border-b border-[#333] hover:bg-[#111]';
            item.innerHTML = `<div class="flex flex-col"><span class="text-white text-xl">${s.name}</span><span class="text-gray-400 text-sm">${s.ip}:${s.port}</span></div><div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="removeServer(${index})">DELETE</div>`;
            container.appendChild(item);
        });
    } catch (e) { console.error("Failed to load servers:", e); container.innerHTML = '<div class="text-center text-red-400 py-4">Error loading servers.</div>'; }
}

async function addServer() {
    const nameInput = document.getElementById('server-name-input');
    const ipInput = document.getElementById('server-ip-input');
    const portInput = document.getElementById('server-port-input');
    if (!nameInput || !ipInput) {
        showToast("Servers UI is missing.");
        return;
    }
    const name = nameInput.value.trim();
    const ip = ipInput.value.trim();
    const port = portInput ? portInput.value.trim() || "25565" : "25565";
    if (!name || !ip) { showToast("Name and IP are required!"); return; }
    const filePath = await getServersFilePath();
    const serverEntry = `${ip}\n${port}\n${name}\n`;
    try {
        const dir = await window.__TAURI__.path.dirname(filePath);
        const dirExists = await safeExists(dir);
        if (!dirExists) await window.__TAURI__.fs.mkdir(dir, { recursive: true });

        const existingContent = (await safeExists(filePath)) ? await window.__TAURI__.fs.readTextFile(filePath) : "";
        await window.__TAURI__.fs.writeTextFile(filePath, existingContent + serverEntry);

        nameInput.value = '';
        ipInput.value = '';
        if (portInput) portInput.value = '';
        showToast("Server Added!"); loadServers();
    } catch (e) { showToast("Failed to save server: " + e.message); }
}

async function removeServer(index) {
    const filePath = await getServersFilePath();
    try {
        const content = await window.__TAURI__.fs.readTextFile(filePath);
        const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '');
        const servers = [];
        for (let i = 0; i < lines.length; i += 3) {
            if (lines[i] && lines[i + 1] && lines[i + 2]) servers.push({ ip: lines[i], port: lines[i + 1], name: lines[i + 2] });
        }
        servers.splice(index, 1);
        let newContent = "";
        servers.forEach(s => { newContent += `${s.ip}\n${s.port}\n${s.name}\n`; });
        await window.__TAURI__.fs.writeTextFile(filePath, newContent);
        loadServers();
        showToast("Server Removed");
    } catch (e) {
        showToast("Failed to remove server: " + e.message);
    }
}

async function updatePlaytimeDisplay() {
    const el = document.getElementById('playtime-display');
    const playtime = await Store.get('legacy_playtime', 0);
    if (el) el.textContent = formatPlaytime(playtime);
}

function formatPlaytime(seconds) {
    const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

async function saveOptions() {
    const repoEl = document.getElementById('repo-input');
    const execEl = document.getElementById('exec-input');
    const compatSelect = document.getElementById('compat-select');
    const ipEl = document.getElementById('ip-input');
    const portEl = document.getElementById('port-input');
    const serverEl = document.getElementById('server-checkbox');
    const customProtonEl = document.getElementById('custom-proton-path');
    const installEl = document.getElementById('install-path-input');

    if (!repoEl || !execEl || !ipEl || !portEl || !serverEl || !installEl) {
        showToast("Settings UI is missing.");
        return;
    }

    const newRepo = repoEl.value.trim();
    const newExec = execEl.value.trim();
    const ip = ipEl.value.trim();
    const port = portEl.value.trim();
    const isServer = serverEl.checked;
    const customProtonPath = customProtonEl ? customProtonEl.value.trim() : "";
    const newInstallPath = installEl.value.trim();

    const oldInstallPath = currentInstance.installPath;

    if (newInstallPath && newInstallPath !== oldInstallPath) {
        const oldExists = await safeExists(oldInstallPath);
        if (oldExists) {
            const preserveList = ['options.txt', 'servers.txt', 'username.txt', 'settings.dat', 'UID.dat', 'Windows64/GameHDD', 'Common/res/mob/char.png'];
            const newExists = await safeExists(newInstallPath);
            if (!newExists) await window.__TAURI__.fs.mkdir(newInstallPath, { recursive: true });

            for (const item of preserveList) {
                const src = await window.__TAURI__.path.join(oldInstallPath, item);
                const dest = await window.__TAURI__.path.join(newInstallPath, item);
                const srcExists = await safeExists(src);
                if (srcExists) {
                    const destDir = await window.__TAURI__.path.dirname(dest);
                    const destDirExists = await safeExists(destDir);
                    if (!destDirExists) await window.__TAURI__.fs.mkdir(destDir, { recursive: true });
                    try {
                        const destExists = await safeExists(dest);
                        if (!destExists) {
                            // Using our download_and_extract command with a special local_copy flag or similar
                            // For simplicity in this script, we'll try to find a better way, but for now just rename if possible
                            // renameSync isn't available in frontend, so we'd need a backend move command
                            // Let's use download_and_extract with local paths
                            await window.__TAURI__.core.invoke('download_and_extract', { url: 'local_copy', extractDir: dest, preserveList: [] });
                        }
                    } catch (e) {
                        console.error("Migration error for " + item + ": " + e.message);
                    }
                }
            }
        }
        currentInstance.installPath = newInstallPath;
    }
    if (newRepo) currentInstance.repo = newRepo;
    if (newExec) currentInstance.execPath = newExec;
    currentInstance.ip = ip;
    currentInstance.port = port;
    currentInstance.isServer = isServer;
    if (compatSelect) {
        currentInstance.compatLayer = compatSelect.value;
        currentInstance.customCompatPath = customProtonPath;
    }
    await saveInstancesToStore();
    toggleOptions(false);
    fetchGitHubData();
    updatePlayButtonText();
    showToast("Settings Saved");
}

async function saveProfile() {
    const usernameEl = document.getElementById('username-input');
    if (!usernameEl) {
        showToast("Profile UI is missing.");
        return;
    }
    let username = usernameEl.value.trim();
    if (username.length > 16) {
        username = username.substring(0, 16);
    }
    await Store.set('legacy_username', username);
    await updateSidebarUser();
    toggleProfile(false); showToast("Profile Updated");
}

function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;

    // Keep toasts on-screen and readable for long messages (paths, errors, etc).
    const text = (msg === null || msg === undefined) ? "" : String(msg);
    t.textContent = text;
    t.style.display = 'block';

    // Restart animation state.
    t.classList.remove('show');
    // eslint-disable-next-line no-unused-expressions
    t.offsetHeight;
    t.classList.add('show');

    // Longer messages stay up a bit longer, capped.
    const ms = Math.min(9000, Math.max(3200, 1800 + text.length * 35));
    clearTimeout(showToast._hideTimer);
    showToast._hideTimer = setTimeout(() => {
        t.classList.remove('show');
        clearTimeout(showToast._hideTimer2);
        showToast._hideTimer2 = setTimeout(() => {
            t.style.display = 'none';
        }, 260);
    }, ms);
}
showToast._hideTimer = null;
showToast._hideTimer2 = null;

async function toggleMusic() { await MusicManager.toggle(); }

async function scanCompatibilityLayers() {
    const select = document.getElementById('compat-select'); if (!select) return;
    const savedValue = currentInstance.compatLayer;
    const layers = [{ name: 'Default (Direct)', cmd: 'direct' }, { name: 'Wine64', cmd: 'wine64' }, { name: 'Wine', cmd: 'wine' }];

    // Add custom option
    layers.push({ name: 'Custom (Linux)', cmd: 'custom' });

    const homeDir = "C:\\Users\\User"; let steamPaths = [];
    if (process.platform === 'linux') steamPaths = [
        await window.__TAURI__.path.join(homeDir, '.steam', 'steam', 'steamapps', 'common'),
        await window.__TAURI__.path.join(homeDir, '.local', 'share', 'Steam', 'steamapps', 'common'),
        await window.__TAURI__.path.join(homeDir, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'common')
    ];
    else if (process.platform === 'darwin') steamPaths = [await window.__TAURI__.path.join(homeDir, 'Library', 'Application Support', 'Steam', 'steamapps', 'common')];

    for (const steamPath of steamPaths) {
        const exists = await safeExists(steamPath);
        if (exists) {
            try {
                const entries = await window.__TAURI__.fs.readDir(steamPath);
                for (const entry of entries) {
                    if (entry.name.startsWith('Proton') || entry.name.includes('Wine') || entry.name.includes('CrossOver')) {
                        const protonPath = await window.__TAURI__.path.join(steamPath, entry.name, 'proton');
                        const pExists = await safeExists(protonPath);
                        if (pExists) layers.push({ name: entry.name, cmd: protonPath });
                    }
                }
            } catch (e) { }
        }
    }
    select.innerHTML = '';
    layers.forEach(l => { const opt = document.createElement('option'); opt.value = l.cmd; opt.textContent = l.name; select.appendChild(opt); if (l.cmd === savedValue) opt.selected = true; });
    updateCompatDisplay();

    const customPathInput = document.getElementById('custom-proton-path');
    if (customPathInput) customPathInput.value = currentInstance.customCompatPath || "";
}

function updateCompatDisplay() {
    const select = document.getElementById('compat-select'); const display = document.getElementById('current-compat-display');
    const customGroup = document.getElementById('custom-proton-group');
    if (select && display && select.selectedIndex !== -1) {
        display.textContent = select.options[select.selectedIndex].text;
        if (customGroup) customGroup.style.display = select.value === 'custom' ? 'block' : 'none';
    }
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar'); const toggleIcon = document.getElementById('sidebar-toggle-icon');
    sidebar.classList.toggle('collapsed');
    if (sidebar.classList.contains('collapsed')) { toggleIcon.textContent = '▶'; toggleIcon.title = 'Expand Patch Notes'; }
    else { toggleIcon.textContent = '◀'; toggleIcon.title = 'Collapse Patch Notes'; }
}

function isNewerVersion(latest, current) {
    const lParts = latest.split('.').map(Number); const cParts = current.split('.').map(Number);
    for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
        const l = lParts[i] || 0; const c = cParts[i] || 0;
        if (l > c) return true; if (l < c) return false;
    }
    return false;
}

async function checkForLauncherUpdates(manual = false) {
    try {
        let currentVersion = "0.1.0"; // Fallback
        try {
            const pkgRes = await fetch('package.json');
            if (pkgRes.ok) {
                const pkg = await pkgRes.json();
                currentVersion = pkg.version;
            }
        } catch (e) { }
        const latestRelease = await httpFetchJson(`https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`);
        const latestVersion = latestRelease.tag_name.replace('v', '');
        if (isNewerVersion(latestVersion, currentVersion)) {
            const updateConfirmed = await promptLauncherUpdate(latestRelease.tag_name, latestRelease.body);
            if (updateConfirmed) downloadAndInstallLauncherUpdate(latestRelease);
        } else if (manual) showToast("Launcher is up to date!");
    } catch (e) { console.error("Launcher update check failed:", e); if (manual) showToast("Update check failed."); }
}

async function promptLauncherUpdate(version, changelog) {
    return new Promise((resolve) => {
        const modal = document.getElementById('update-modal');
        const confirmBtn = document.getElementById('btn-confirm-update');
        const skipBtn = document.getElementById('btn-skip-update');
        const closeBtn = document.getElementById('btn-close-update');
        const modalText = document.getElementById('update-modal-text');
        if (modalText) {
            modalText.innerHTML = `<span class="update-tag">NEW UPDATE: v${version}</span><br><div class="pn-body" style="font-size: 16px; max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 10px; margin-top: 5px;">${changelog || "No changelog provided."}</div>`;
            modalText.style.display = 'block';
        }
        document.activeElement?.blur(); modal.style.display = 'flex'; modal.style.opacity = '1';
        const cleanup = (result) => {
            modal.style.opacity = '0'; setTimeout(() => { modal.style.display = 'none'; if (modalText) modalText.style.display = 'none'; }, 300);
            confirmBtn.onclick = null; skipBtn.onclick = null; closeBtn.onclick = null; resolve(result);
        };
        confirmBtn.onclick = () => cleanup(true); skipBtn.onclick = () => cleanup(false); closeBtn.onclick = () => cleanup(false);
    });
}

async function downloadAndInstallLauncherUpdate(release) {
    setProcessingState(true); updateProgress(0, "Preparing Launcher Update...");
    let assetPattern = "";
    if (process.platform === 'win32') assetPattern = ".exe";
    else if (process.platform === 'linux') assetPattern = ".appimage";
    else if (process.platform === 'darwin') assetPattern = ".dmg";
    const asset = release.assets.find(a => a.name.toLowerCase().endsWith(assetPattern));
    if (!asset) { showToast("No compatible update found for your OS."); setProcessingState(false); return; }
    try {
        const homeDir = await window.__TAURI__.path.downloadDir(); const downloadPath = await window.__TAURI__.path.join(homeDir, asset.name);
        updateProgress(10, `Downloading Launcher Update...`); await downloadFile(asset.browser_download_url, downloadPath);
        updateProgress(100, "Download Complete. Launching Installer...");
        await new Promise(r => setTimeout(r, 1000));
        if (process.platform === 'win32') await window.__TAURI__.shell.open(downloadPath);
        else if (process.platform === 'linux') {
            // Note: chmod might be needed, currently handled in backend if possible 
            await window.__TAURI__.shell.open(downloadPath);
        }
        else if (process.platform === 'darwin') await window.__TAURI__.shell.open(downloadPath);
        setTimeout(() => ipcRenderer.send('window-close'), 2000);
    } catch (e) { showToast("Launcher Update Error: " + e.message); setProcessingState(false); }
}

async function loadSplashText() {
    const splashEl = document.getElementById('splash-text');
    if (!splashEl) return;
    try {
        const response = await fetch('strings.txt');
        if (response.ok) {
            const content = await response.text();
            const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '');
            if (lines.length > 0) {
                const randomSplash = lines[Math.floor(Math.random() * lines.length)];
                splashEl.textContent = randomSplash;
            }
        }
    } catch (e) {
        console.error("Failed to load splash text:", e);
        splashEl.textContent = "Welcome!";
    }
}

async function toggleSnapshots(show, id = null) {
    const modal = document.getElementById('snapshots-modal');
    if (show) {
        snapshotInstanceId = id || currentInstanceId;
        const inst = instances.find(i => i.id === snapshotInstanceId);
        const nameEl = document.getElementById('snapshot-instance-name');
        if (nameEl) nameEl.textContent = inst ? inst.name : "";
        await renderSnapshotsList();
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

async function renderSnapshotsList() {
    const container = document.getElementById('snapshots-list-container');
    container.innerHTML = '';
    const inst = instances.find(i => i.id === snapshotInstanceId);
    if (!inst || !inst.snapshots || inst.snapshots.length === 0) {
        container.innerHTML = '<div class="text-center text-gray-400 py-4">No snapshots found.</div>';
        return;
    }

    inst.snapshots.sort((a, b) => b.timestamp - a.timestamp).forEach((snap) => {
        const item = document.createElement('div');
        item.className = 'flex justify-between items-center p-3 border-b border-[#333] hover:bg-[#111]';
        const date = new Date(snap.timestamp).toLocaleString();
        item.innerHTML = `
            <div class="flex flex-col">
                <span class="text-white text-lg font-bold">${snap.tag || 'Unknown Version'}</span>
                <span class="text-gray-400 text-sm">${date}</span>
            </div>
            <div class="flex gap-2">
                <div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="rollbackToSnapshot('${snap.id}')">ROLLBACK</div>
                <div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="deleteSnapshot('${snap.id}')">DELETE</div>
            </div>
        `;
        container.appendChild(item);
    });
}

function openSnapshotsManager(id) {
    toggleSnapshots(true, id);
}

async function createSnapshotManual() {
    const inst = instances.find(i => i.id === snapshotInstanceId);
    if (!inst) return;
    setProcessingState(true);
    updateProgress(0, "Creating Snapshot...");
    try {
        await createSnapshot(inst);
        showToast("Snapshot Created!");
        await renderSnapshotsList();
    } catch (e) {
        showToast("Failed to create snapshot: " + e.message);
    }
    setProcessingState(false);
}

async function createSnapshot(inst) {
    const exists = await safeExists(inst.installPath);
    if (!exists) return;

    const snapshotId = 'snap-' + Date.now();
    const parentDir = await window.__TAURI__.path.dirname(inst.installPath);
    const snapshotsDir = await window.__TAURI__.path.join(parentDir, 'Snapshots', inst.id);
    const dirExists = await safeExists(snapshotsDir);
    if (!dirExists) await window.__TAURI__.fs.mkdir(snapshotsDir, { recursive: true });

    const dest = await window.__TAURI__.path.join(snapshotsDir, snapshotId);

    // Copy entire folder to dest (This will require Rust backend support or looping, but for now we fallback)
    await window.__TAURI__.core.invoke('download_and_extract', { url: "local_copy", extractDir: dest, preserveList: [] });

    if (!inst.snapshots) inst.snapshots = [];
    inst.snapshots.push({
        id: snapshotId,
        timestamp: Date.now(),
        tag: inst.installedTag || 'Manual Snapshot',
        path: dest
    });

    await saveInstancesToStore();
}

async function rollbackToSnapshot(snapId) {
    const inst = instances.find(i => i.id === snapshotInstanceId);
    if (!inst) return;
    const snap = inst.snapshots.find(s => s.id === snapId);
    if (!snap) return;

    if (!confirm(`Are you sure you want to ROLLBACK ${inst.name} to the snapshot from ${new Date(snap.timestamp).toLocaleString()}? This will overwrite your current files.`)) return;

    setProcessingState(true);
    updateProgress(10, "Preparing Rollback...");

    try {
        const installDirExists = await safeExists(inst.installPath);
        if (installDirExists) {
            // Move current to temp just in case
            const temp = inst.installPath + "_rollback_temp";
            const tempExists = await safeExists(temp);
            if (tempExists) await window.__TAURI__.fs.remove(temp, { recursive: true });

            // We really need a 'rename' command in the backend for folders, but let's try reading and writing if small, 
            // or use our download_and_extract with local_copy
            await window.__TAURI__.core.invoke('download_and_extract', { url: "local_copy", extractDir: temp, preserveList: [] });
        }

        updateProgress(50, "Restoring Files...");
        await window.__TAURI__.core.invoke('download_and_extract', { url: "local_copy", extractDir: inst.installPath, preserveList: [] });

        inst.installedTag = snap.tag;
        await saveInstancesToStore();

        // Cleanup temp
        const temp = inst.installPath + "_rollback_temp";
        const tempExists = await safeExists(temp);
        if (tempExists) await window.__TAURI__.fs.remove(temp, { recursive: true });

        showToast("Rollback Successful!");
        if (snapshotInstanceId === currentInstanceId) {
            updatePlayButtonText();
            if (window.loadMainMenuSkin) window.loadMainMenuSkin();
        }
    } catch (e) {
        showToast("Rollback Failed: " + e.message);
        console.error(e);
    }
    setProcessingState(false);
}

async function deleteSnapshot(snapId) {
    const inst = instances.find(i => i.id === snapshotInstanceId);
    if (!inst) return;
    const snapIndex = inst.snapshots.findIndex(s => s.id === snapId);
    if (snapIndex === -1) return;

    if (!confirm("Delete this snapshot? (This will free up disk space)")) return;

    try {
        const snap = inst.snapshots[snapIndex];
        const exists = await safeExists(snap.path);
        if (exists) {
            await window.__TAURI__.fs.remove(snap.path, { recursive: true });
        }
        inst.snapshots.splice(snapIndex, 1);
        await saveInstancesToStore();
        renderSnapshotsList();
        showToast("Snapshot Deleted");
    } catch (e) {
        showToast("Error deleting snapshot: " + e.message);
    }
}

// Global functions for HTML onclick
window.toggleSidebar = toggleSidebar;
window.minimizeWindow = minimizeWindow;
window.toggleMaximize = toggleMaximize;
window.closeWindow = closeWindow;
window.launchGame = launchGame;
window.updateSelectedRelease = updateSelectedRelease;
window.toggleProfile = toggleProfile;
window.toggleServers = toggleServers;
window.toggleInfo = toggleInfo;
window.toggleCreateServer = toggleCreateServer;
window.launchServer = launchServer;
window.serverAction = serverAction;
window.stopServer = stopServer;
window.saveServerSetting = saveServerSetting;
window.saveServerNumberSetting = saveServerNumberSetting;
window.browseServerDir = browseServerDir;
window.openServerDir = openServerDir;
window.setServerDir = setServerDir;
window.addServer = addServer;
window.removeServer = removeServer;
window.toggleOptions = toggleOptions;
window.saveOptions = saveOptions;
window.saveProfile = saveProfile;
window.updateCompatDisplay = updateCompatDisplay;
window.checkForUpdatesManual = checkForUpdatesManual;
window.browseInstallDir = browseInstallDir;
window.openGameDir = openGameDir;
window.toggleMusic = toggleMusic;
window.getInstallDir = getInstallDir;
window.showToast = showToast;
window.toggleInstances = toggleInstances;
window.createNewInstance = createNewInstance;
window.saveNewInstance = saveNewInstance;
window.switchInstance = switchInstance;
window.deleteInstance = deleteInstance;
window.toggleAddInstance = toggleAddInstance;
window.openSnapshotsManager = openSnapshotsManager;
window.rollbackToSnapshot = rollbackToSnapshot;
window.deleteSnapshot = deleteSnapshot;
window.createSnapshotManual = createSnapshotManual;
window.toggleSnapshots = toggleSnapshots;
// Desktop shortcut for Linux AppImage
async function ensureDesktopShortcut() {
    if (process.platform !== 'linux') return;
    try {
        const home = await window.__TAURI__.path.homeDir();
        const desktopDir = await window.__TAURI__.path.join(home, '.local', 'share', 'applications');
        const desktopPath = await window.__TAURI__.path.join(desktopDir, 'LegacyLauncher.desktop');

        const exists = await safeExists(desktopPath);
        if (exists) return;

        const appPath = await window.__TAURI__.core.invoke('get_app_path').catch(() => null);
        if (!appPath) return;

        const content = `[Desktop Entry]
Type=Application
Name=LegacyLauncher
Comment=LegacyLauncher AppImage
Exec="${appPath}" %U
Icon=LegacyLauncher
Terminal=false
Categories=Game;Emulation;`;

        const dirExists = await safeExists(desktopDir);
        if (!dirExists) await window.__TAURI__.fs.mkdir(desktopDir, { recursive: true });
        await window.__TAURI__.fs.writeTextFile(desktopPath, content);
    } catch (e) {
        console.error('Failed to create desktop shortcut:', e);
    }
}
// Ensure shortcut exists on startup
ensureDesktopShortcut();


