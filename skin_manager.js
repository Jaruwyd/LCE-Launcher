// skin_manager.js
// Handles skin uploading, conversion, 3D preview, and saving to char.png

let mainMenuScene, mainMenuCamera, mainMenuRenderer, mainMenuPlayerGroup;
let isMainSkinDragging = false;

let skinScene, skinCamera, skinRenderer, skinPlayerGroup;
let isSkinDragging = false;
let previousSkinMousePosition = { x: 0, y: 0 };
let processedSkinDataUrl = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const skinInput = document.getElementById('skin-input');
    const dropZone = document.getElementById('drop-zone');
    const saveSkinBtn = document.getElementById('save-skin-btn');
    const closeSkinBtn = document.getElementById('btn-close-skin');

    if (skinInput) skinInput.addEventListener('change', (e) => handleSkinFile(e.target.files[0]));

    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('border-green-500');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-green-500'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('border-green-500');
            handleSkinFile(e.dataTransfer.files[0]);
        });
    }

    if (saveSkinBtn) {
        saveSkinBtn.addEventListener('click', saveSkinToDisk);
    }

    if (closeSkinBtn) {
        closeSkinBtn.addEventListener('click', closeSkinManager);
    }

    const saveToLibraryBtn = document.getElementById('save-to-library-btn');
    if (saveToLibraryBtn) {
        saveToLibraryBtn.addEventListener('click', saveSkinToLibrary);
    }

    // Initialize Main Menu Viewer
    initMainMenuSkinViewer();
});

function initMainMenuSkinViewer() {
    const container = document.getElementById('main-skin-viewer');
    if (!container) return;

    mainMenuScene = new THREE.Scene();
    mainMenuCamera = new THREE.PerspectiveCamera(45, container.offsetWidth / container.offsetHeight, 0.1, 1000);
    mainMenuCamera.position.set(0, 5, 60);

    mainMenuRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    mainMenuRenderer.setSize(container.offsetWidth, container.offsetHeight);
    mainMenuRenderer.setPixelRatio(window.devicePixelRatio);
    mainMenuRenderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(mainMenuRenderer.domElement);

    mainMenuScene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 0.5);
    dl.position.set(10, 20, 15);
    mainMenuScene.add(dl);

    mainMenuPlayerGroup = new THREE.Group();
    mainMenuScene.add(mainMenuPlayerGroup);

    // Interaction for Main Menu Viewer
    let prevX = 0;
    container.addEventListener('mousedown', (e) => {
        isMainSkinDragging = true;
        prevX = e.clientX;
    });
    window.addEventListener('mouseup', () => isMainSkinDragging = false);
    window.addEventListener('mousemove', (e) => {
        if (isMainSkinDragging && mainMenuPlayerGroup) {
            mainMenuPlayerGroup.rotation.y += (e.clientX - prevX) * 0.01;
            prevX = e.clientX;
        }
    });

    // Auto-rotate slowly
    function animateMain() {
        requestAnimationFrame(animateMain);
        if (!isMainSkinDragging && mainMenuPlayerGroup) mainMenuPlayerGroup.rotation.y += 0.005;
        if (mainMenuRenderer && mainMenuScene && mainMenuCamera) mainMenuRenderer.render(mainMenuScene, mainMenuCamera);
    }
    animateMain();

    // Load current skin after short delay to ensure paths are ready
    setTimeout(loadMainMenuSkin, 500);

    // Handle window resize
    window.addEventListener('resize', () => {
        if (mainMenuCamera && mainMenuRenderer && container) {
            mainMenuCamera.aspect = container.offsetWidth / container.offsetHeight;
            mainMenuCamera.updateProjectionMatrix();
            mainMenuRenderer.setSize(container.offsetWidth, container.offsetHeight);
        }
    });
}

async function loadMainMenuSkin() {
    try {
        // Ensure install dir is available (currentInstance might not be ready)
        const installDir = await window.getInstallDir();
        if (!installDir) return;

        const skinPath = await window.__TAURI__.path.join(installDir, 'Common', 'res', 'mob', 'char.png');

        const exists = await window.__TAURI__.fs.exists(skinPath);
        if (exists) {
            const skinData = await window.__TAURI__.fs.readFile(skinPath);
            const blob = new Blob([skinData]);
            const url = URL.createObjectURL(blob);

            const img = new Image();
            img.onload = () => {
                const isLegacy = img.height === 32;
                updateSkinModel(img.src, isLegacy, mainMenuPlayerGroup);
                updateSidebarHead(img.src);
            };
            img.src = url;
        } else {
            console.log("No skin found at " + skinPath);
        }
    } catch (e) {
        console.warn("Could not load main menu skin (startup race condition?):", e);
    }
}

function updateSkinModel(dataUrl, isLegacy, targetGroup) {
    if (!targetGroup) return;

    new THREE.TextureLoader().load(dataUrl, (texture) => {
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.encoding = THREE.sRGBEncoding;

        // Clear existing children
        while (targetGroup.children.length > 0) targetGroup.remove(targetGroup.children[0]);

        const createFaceMaterial = (tex, x, y, w, h) => {
            const texWidth = tex.image.width;
            const texHeight = tex.image.height;
            const matTex = tex.clone();
            matTex.magFilter = THREE.NearestFilter;
            matTex.minFilter = THREE.NearestFilter;
            matTex.repeat.set(w / texWidth, h / texHeight);
            matTex.offset.set(x / texWidth, 1 - (y + h) / texHeight);
            matTex.needsUpdate = true;
            return new THREE.MeshLambertMaterial({ map: matTex, transparent: true, alphaTest: 0.5, side: THREE.FrontSide });
        };

        const createBodyPart = (w, h, d, tex, uv, offset = 0) => {
            const geometry = new THREE.BoxGeometry(w, h, d);
            const materials = [
                createFaceMaterial(tex, uv.left[0], uv.left[1], uv.left[2], uv.left[3]), // Left (Standard MC "Right")
                createFaceMaterial(tex, uv.right[0], uv.right[1], uv.right[2], uv.right[3]), // Right (Standard MC "Left")
                createFaceMaterial(tex, uv.top[0], uv.top[1], uv.top[2], uv.top[3]),
                createFaceMaterial(tex, uv.bottom[0], uv.bottom[1], uv.bottom[2], uv.bottom[3]),
                createFaceMaterial(tex, uv.front[0], uv.front[1], uv.front[2], uv.front[3]),
                createFaceMaterial(tex, uv.back[0], uv.back[1], uv.back[2], uv.back[3])
            ];
            const mesh = new THREE.Mesh(geometry, materials);
            if (offset !== 0) mesh.scale.set(1 + offset, 1 + offset, 1 + offset);
            return mesh;
        };

        const limbUv = (x, y) => ({
            top: [x + 4, y, 4, 4], bottom: [x + 8, y, 4, 4],
            right: [x, y + 4, 4, 12], front: [x + 4, y + 4, 4, 12],
            left: [x + 8, y + 4, 4, 12], back: [x + 12, y + 4, 4, 12]
        });

        // Head
        const headUvs = { top: [8, 0, 8, 8], bottom: [16, 0, 8, 8], right: [0, 8, 8, 8], left: [16, 8, 8, 8], front: [8, 8, 8, 8], back: [24, 8, 8, 8] };
        const head = createBodyPart(8, 8, 8, texture, headUvs);
        head.position.y = 10;
        targetGroup.add(head);

        // Hat
        const hatUvs = { top: [40, 0, 8, 8], bottom: [48, 0, 8, 8], right: [32, 8, 8, 8], left: [48, 8, 8, 8], front: [40, 8, 8, 8], back: [56, 8, 8, 8] };
        const hat = createBodyPart(8, 8, 8, texture, hatUvs, 0.12);
        hat.position.y = 10;
        targetGroup.add(hat);

        // Torso
        const torsoUvs = { top: [20, 16, 8, 4], bottom: [28, 16, 8, 4], right: [16, 20, 4, 12], left: [28, 20, 4, 12], front: [20, 20, 8, 12], back: [32, 20, 8, 12] };
        targetGroup.add(createBodyPart(8, 12, 4, texture, torsoUvs));

        // Jacket (non-legacy only)
        if (!isLegacy) {
            const jacketUvs = { top: [20, 32, 8, 4], bottom: [28, 32, 8, 4], right: [16, 36, 4, 12], left: [28, 36, 4, 12], front: [20, 36, 8, 12], back: [32, 36, 8, 12] };
            targetGroup.add(createBodyPart(8, 12, 4, texture, jacketUvs, 0.05));
        }

        // Limbs
        const limbs = [
            { pos: [-6, 0, 0], uv: limbUv(40, 16), layerUv: limbUv(40, 32) },
            { pos: [6, 0, 0], uv: isLegacy ? limbUv(40, 16) : limbUv(32, 48), layerUv: limbUv(48, 48) },
            { pos: [-2, -12, 0], uv: limbUv(0, 16), layerUv: limbUv(0, 32) },
            { pos: [2, -12, 0], uv: isLegacy ? limbUv(0, 16) : limbUv(16, 48), layerUv: limbUv(0, 48) }
        ];

        limbs.forEach(l => {
            const base = createBodyPart(4, 12, 4, texture, l.uv);
            base.position.set(...l.pos);
            targetGroup.add(base);
            if (!isLegacy) {
                const layer = createBodyPart(4, 12, 4, texture, l.layerUv, 0.05);
                layer.position.set(...l.pos);
                targetGroup.add(layer);
            }
        });
    });
}

async function openSkinManager() {
    const modal = document.getElementById('skin-modal');
    modal.style.display = 'flex';
    modal.style.opacity = '1';

    // Clear previous state in modal
    const previewContainer = document.getElementById('preview-container');
    if (previewContainer) previewContainer.classList.remove('hidden'); // Show it by default now

    // Load current skin into preview
    loadCurrentSkinToPreview();

    // Load Skin Library
    loadSkinLibrary();
}

async function loadCurrentSkinToPreview() {
    try {
        const installDir = await window.getInstallDir();
        if (!installDir) return;
        const skinPath = await window.__TAURI__.path.join(installDir, 'Common', 'res', 'mob', 'char.png');
        const exists = await window.__TAURI__.fs.exists(skinPath);
        if (exists) {
            const skinData = await window.__TAURI__.fs.readFile(skinPath);
            const blob = new Blob([skinData]);
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const isLegacy = img.height === 32;
                processSkinImage(img, img.src, true);
            };
            img.src = url;
        }
    } catch (e) {
        console.warn("Failed to load current skin for preview:", e);
    }
}

function closeSkinManager() {
    const modal = document.getElementById('skin-modal');
    modal.style.opacity = '0';
    setTimeout(() => {
        modal.style.display = 'none';

        // Reset state
        const prompt = document.getElementById('upload-prompt');
        if (prompt) prompt.style.display = 'block';

        const previewContainer = document.getElementById('preview-container');
        if (previewContainer) previewContainer.classList.add('hidden');

        processedSkinDataUrl = null;

    }, 300);
}

function handleSkinFile(file) {
    if (!file || !file.type.includes('png')) return window.showToast("Only PNG files are supported!");

    const prompt = document.getElementById('upload-prompt');
    if (prompt) prompt.style.display = 'none';

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            processSkinImage(img, e.target.result);
        };
        img.onerror = () => {
            window.showToast("Failed to load image");
            if (prompt) prompt.style.display = 'block';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function processSkinImage(img, srcUrl, isInitialLoad = false) {
    const canvas = document.getElementById('skin-canvas');
    const ctx = canvas.getContext('2d');
    const formatLabel = document.getElementById('format-label');
    const statusMessage = document.getElementById('status-message');
    const previewContainer = document.getElementById('preview-container');
    const saveBtn = document.getElementById('save-skin-btn');
    const dropZone = document.getElementById('drop-zone');

    if (img.width !== 64) {
        if (previewContainer) previewContainer.classList.add('hidden');
        return window.showToast("Invalid skin width. Must be 64px.");
    }

    const isLegacy = img.height === 32;

    // Set canvas dimensions based on skin height
    canvas.height = img.height;
    ctx.clearRect(0, 0, 64, img.height);
    ctx.drawImage(img, 0, 0);
    processedSkinDataUrl = canvas.toDataURL('image/png');

    if (previewContainer) previewContainer.classList.remove('hidden');

    if (isInitialLoad) {
        if (formatLabel) formatLabel.textContent = isLegacy ? "64x32 (Legacy)" : "64x64 (Modern)";
        if (statusMessage) statusMessage.innerHTML = "<span style='color: #60a5fa;'>CURRENT SKIN</span>";
        if (saveBtn) {
            saveBtn.textContent = "CURRENT SKIN";
            saveBtn.classList.add('disabled');
        }
    } else {
        if (formatLabel) formatLabel.textContent = isLegacy ? "64x32 (Legacy)" : "64x64 (Modern)";
        if (statusMessage) statusMessage.innerHTML = isLegacy ? "<span style='color: #4ade80;'>NEW SKIN READY</span>" : "<span style='color: #facc15;'>CONVERTING TO 64x32</span>";
        if (saveBtn) {
            saveBtn.textContent = "UPDATE SKIN";
            saveBtn.classList.remove('disabled');
        }
    }

    if (!skinScene) initPreviewEngine();
    updateSkinModel(srcUrl, isLegacy, skinPlayerGroup);
    updateSidebarHead(srcUrl);
}

function updateSidebarHead(srcUrl) {
    const canvas = document.getElementById('sidebar-head-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Face (8x8 at 8,8)
        ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
        // Overlay (8x8 at 40,8)
        ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    };
    img.src = srcUrl;
}

function initPreviewEngine() {
    const container = document.getElementById('skin-viewer-container');
    if (!container) return;

    skinScene = new THREE.Scene();
    skinCamera = new THREE.PerspectiveCamera(35, container.offsetWidth / container.offsetHeight, 0.1, 1000);
    skinCamera.position.set(0, 5, 70);

    skinRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    skinRenderer.setSize(container.offsetWidth, container.offsetHeight);
    skinRenderer.setPixelRatio(window.devicePixelRatio);
    skinRenderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(skinRenderer.domElement);

    skinScene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dl = new THREE.DirectionalLight(0xffffff, 0.35);
    dl.position.set(10, 20, 15);
    skinScene.add(dl);

    skinPlayerGroup = new THREE.Group();
    skinScene.add(skinPlayerGroup);

    container.addEventListener('mousedown', () => isSkinDragging = true);
    window.addEventListener('mouseup', () => isSkinDragging = false);
    window.addEventListener('mousemove', (e) => {
        if (isSkinDragging && skinPlayerGroup) {
            skinPlayerGroup.rotation.y += (e.movementX) * 0.01;
        }
    });

    function animate() {
        requestAnimationFrame(animate);
        if (!isSkinDragging && skinPlayerGroup) skinPlayerGroup.rotation.y += 0.008;
        if (skinRenderer && skinScene && skinCamera) skinRenderer.render(skinScene, skinCamera);
    }
    animate();
}

async function saveSkinToDisk() {
    if (!processedSkinDataUrl) return;

    try {
        const installDir = await window.getInstallDir();
        const savePath = await window.__TAURI__.path.join(installDir, 'Common', 'res', 'mob', 'char.png');
        const dir = await window.__TAURI__.path.dirname(savePath);

        const dirExists = await window.__TAURI__.fs.exists(dir);
        if (!dirExists) {
            await window.__TAURI__.fs.mkdir(dir, { recursive: true });
        }

        const base64Data = processedSkinDataUrl.replace(/^data:image\/png;base64,/, "");
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);

        await window.__TAURI__.fs.writeFile(savePath, byteArray);

        window.showToast("Skin Saved Successfully!");

        const saveBtn = document.getElementById('save-skin-btn');
        if (saveBtn) {
            saveBtn.textContent = "SAVED!";
            saveBtn.classList.add('disabled');
        }

        loadMainMenuSkin();
        setTimeout(closeSkinManager, 1000);

    } catch (e) {
        window.showToast("Error Saving Skin: " + e.message);
        console.error(e);
    }
}

async function saveSkinToLibrary() {
    if (!processedSkinDataUrl) return window.showToast("No skin to save!");

    try {
        const installDir = await window.getInstallDir();
        const skinsDir = await window.__TAURI__.path.join(installDir, 'Skins');
        const skinsDirExists = await window.__TAURI__.fs.exists(skinsDir);
        if (!skinsDirExists) await window.__TAURI__.fs.mkdir(skinsDir, { recursive: true });

        const filename = `skin_${Date.now()}.png`;
        const savePath = await window.__TAURI__.path.join(skinsDir, filename);

        const base64Data = processedSkinDataUrl.replace(/^data:image\/png;base64,/, "");
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);

        await window.__TAURI__.fs.writeFile(savePath, byteArray);

        window.showToast("Skin added to library!");
        loadSkinLibrary();
    } catch (e) {
        window.showToast("Error saving to library: " + e.message);
    }
}

async function loadSkinLibrary() {
    const list = document.getElementById('skin-library-list');
    if (!list) return;

    try {
        const installDir = await window.getInstallDir();
        const skinsDir = await window.__TAURI__.path.join(installDir, 'Skins');
        const exists = await window.__TAURI__.fs.exists(skinsDir);
        if (!exists) {
            list.innerHTML = '<div class="text-[10px] text-gray-700 font-bold uppercase py-4 italic">No skins saved yet.</div>';
            return;
        }

        const entries = await window.__TAURI__.fs.readDir(skinsDir);
        const files = entries.filter(e => e.name.endsWith('.png'));

        if (files.length === 0) {
            list.innerHTML = '<div class="text-[10px] text-gray-700 font-bold uppercase py-4 italic">No skins saved yet.</div>';
            return;
        }

        list.innerHTML = '';
        for (const file of files) {
            const filePath = await window.__TAURI__.path.join(skinsDir, file.name);
            const skinData = await window.__TAURI__.fs.readFile(filePath);
            const blob = new Blob([skinData]);
            const url = URL.createObjectURL(blob);

            const item = document.createElement('div');
            item.className = 'w-16 h-16 bg-black/40 rounded-xl border border-white/5 flex-shrink-0 cursor-pointer hover:border-green-500 overflow-hidden group relative';
            item.innerHTML = `
                <canvas width="32" height="32" class="w-full h-full" style="image-rendering:pixelated;"></canvas>
                <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <i class="ph-bold ph-check text-green-500"></i>
                </div>
            `;

            const canvas = item.querySelector('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = () => {
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 32, 32);
                ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 32, 32);
            };
            img.src = url;

            item.onclick = () => applyLibrarySkin(file.name);
            list.appendChild(item);
        }
    } catch (e) {
        console.error("Error loading skin library:", e);
    }
}

async function applyLibrarySkin(skinName) {
    try {
        const installDir = await window.getInstallDir();
        const sourcePath = await window.__TAURI__.path.join(installDir, 'Skins', skinName);
        const skinData = await window.__TAURI__.fs.readFile(sourcePath);
        const blob = new Blob([skinData]);
        const url = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
            processSkinImage(img, url, false);
            window.showToast("Skin loaded! Click Update to use it.");
        };
        img.src = url;
    } catch (e) {
        window.showToast("Error applying skin: " + e.message);
    }
}

// Global Export
window.openSkinManager = openSkinManager;
window.initMainMenuSkinViewer = initMainMenuSkinViewer;
window.loadMainMenuSkin = loadMainMenuSkin;
