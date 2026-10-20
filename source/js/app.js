import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';

// ---- Site configuration ------------------------------------------------------
// Written by tools/build_site.py. `shapes` holds ONE silhouette in the normal case:
// it decomposes into fragments then recomposes into itself, and stays the same object
// for the whole scroll. Give two silhouettes instead and the scroll morphs from the
// first into the second (legacy behaviour). Any SVG with one outer contour (plus
// optional holes or separate solids) works — from tools/make_shape.py, hand-authored,
// or a real logo. `palette` tints the four light chapters of the background (caramel
// glow and drizzle over crème pâtissière); the fifth is the ember glow of the dark
// contact chapter.
const SITE = {
    shapes: ['./assets/shapes/shape.svg'],
    palette: ['#C8791F', '#FFB43A', '#D98B2B', '#C8791F', '#D98B2B'],
    fragments: 4
};

// CRM Brûlée surfaces: the page colours the shader and the glass are built from.
const BRAND = {
    creme: '#FBF3DD', creme2: '#F3EEE3', brun: '#2B1A0E', caramel: '#C8791F',
    caramelFonce: '#9A5A12', coeur: '#FFB43A', reflet: '#FFE2B0'
};

// prefers-reduced-motion: the scene follows the scroll without inertia, and nothing
// moves on its own (no drifting sugar, no breathing background, no pointer tilt).
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
motionQuery.addEventListener?.('change', event => { reducedMotion = event.matches; });

const SINGLE_SHAPE = SITE.shapes.length === 1;

const shapeSources = await Promise.all(SITE.shapes.map(async (path) => {
    const response = await fetch(new URL(path, document.baseURI));
    if (!response.ok) throw new Error(`Unable to load ${path}`);
    return response.text();
}));

// One shape means the morph targets the silhouette itself: the fragments fly apart and
// come back to exactly where they left. Using the same source on both ends keeps the
// rest of the engine untouched — the correspondence it builds is simply the identity.
// (build_monofichier.py replaces the block above with a literal of the same length, so
// the two ends are derived here rather than by fetching the file twice.)
const openingSource = shapeSources[0];
const finalSource = SINGLE_SHAPE ? shapeSources[0] : shapeSources[1];

// ---- Tunables ---------------------------------------------------------------
const LOGO_HEIGHT = 3.1;                              // opening shape, world units
const LOGO_DEPTH = 0.46;
const LOGO_BEVEL = { size: 0.075, thickness: 0.11 };   // round, glazed edges: a sugar shard, not a cut pane
// With a single shape the recomposed prism must match the one that broke apart, down to
// the bevel: any difference would read as the object quietly resizing mid-scroll.
const ICON_SIZE = SINGLE_SHAPE ? LOGO_HEIGHT : 2.9;   // final shape
const ICON_DEPTH = SINGLE_SHAPE ? LOGO_DEPTH : 0.50;
const ICON_BEVEL = SINGLE_SHAPE ? LOGO_BEVEL : { size: 0.028, thickness: 0.038 };
const SEAM_BEVEL = 0.006;                             // bevel while fragments merge

const canvas = document.querySelector('#webgl');
let scene, camera, renderer;
let modelPivot;    // pivot group for perfect center-rotation
const logoPieces = [];
let wholeBody;     // the opening shape, whole, while it is still assembled
let glassIcon;     // single final prism: the whole final shape
let iconOutline = [];                    // final outline, world units, centred
let iconHoles = [];                      // its holes, punched once the fragments merge
let lastLogoMorph = -1;
const clock = new THREE.Clock();
let currentScroll = 0;   // smoothed accumulated scroll for lerping
let currentContact = 0, targetContact = 0;   // 0..1 progress into the contact chapter
const stageElement = document.querySelector('.scroll-stage');
const contactSection = document.querySelector('#contact');
const contactCardElement = document.querySelector('.contact-card');
let glassCard;                 // liquid-glass slab pinned behind the contact card
let cardGlass;                 // its smoked, frosted material
const CARD_DISTANCE = 6.0;     // camera-space depth of the slab's front face
const CARD_RIM_PX = 16, CARD_RADIUS_PX = 30, CARD_DEPTH = 0.08, CARD_RIM_DEPTH = 0.06;

// The WebGL glass card behind the contact form is the single most expensive surface of
// the page (a screen-sized transmissive slab). The CSS caramel card looks the same on
// chocolate, so the slab stays off.
const GLASS_CARD = false;

// Resolution governor: transmissive glass is paid per pixel. Render at the screen's own
// density so the flame stays crisp, capped by a total pixel budget on very large windows.
// If frames then miss the 60 fps budget, step down once and stay there: a modest GPU
// stays fluid. Text is DOM and never loses sharpness.
const PIXEL_BUDGET = 4.4e6, MAX_PIXEL_RATIO = 2;
let governorScale = 1;                 // lowered for good when the GPU cannot keep up
function targetPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    const budget = Math.sqrt(PIXEL_BUDGET / Math.max(1, window.innerWidth * window.innerHeight));
    const crisp = Math.min(dpr, MAX_PIXEL_RATIO, budget);
    return Math.max(Math.min(dpr, 1), crisp * governorScale);
}
let pixelRatio = targetPixelRatio();
const frameIntervals = [];
function governResolution(interval) {
    if (interval > 100) return;                       // a hitch or a wake-up, not a trend
    frameIntervals.push(interval);
    if (frameIntervals.length < 60) return;
    const sorted = frameIntervals.splice(0).sort((a, b) => a - b);
    // Step down as soon as a quarter of the frames miss, not half: on a phone, one frame
    // in four dropped already reads as stutter.
    const slow = sorted[Math.floor(sorted.length * 0.75)];
    if (slow > 24 && governorScale > 0.6) {
        governorScale = Math.max(0.6, governorScale - 0.15);
        const next = targetPixelRatio();
        if (Math.abs(next - pixelRatio) > 0.01) {
            pixelRatio = next;
            renderer.setPixelRatio(pixelRatio);
            renderer.getDrawingBufferSize(shaderUniforms.uResolution.value);
        }
    }
}

let mouseX = 0, mouseY = 0, targetMouseX = 0, targetMouseY = 0;

let cursorX = window.innerWidth / 2,  cursorY = window.innerHeight / 2;
let outerCursorX = window.innerWidth / 2, outerCursorY = window.innerHeight / 2;

let bgMaterial, bgMesh;
const paletteUniforms = Object.fromEntries(SITE.palette.map((hex, index) =>
    [`uC${index}`, { value: new THREE.Color(hex) }]));
const shaderUniforms = {
    ...paletteUniforms,
    uCreme: { value: new THREE.Color(BRAND.creme) },
    uCreme2: { value: new THREE.Color(BRAND.creme2) },
    uBrun: { value: new THREE.Color(BRAND.brun) },
    uReflet: { value: new THREE.Color(BRAND.reflet) },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uScroll: { value: 0 },
    uContact: { value: 0 },
    uVelocity: { value: 0 },
    // Per-ribbon phases of the drizzle, set once per frame by updateRibbonPhases().
    uRibbonPhase: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uRibbonLift: { value: new THREE.Vector3() },
    uWave: { value: new THREE.Vector2() }
};

// The drizzle used to take an atan and three sines per ribbon and per pixel. Everything
// that depends only on time and scroll is computed here once per frame instead: the
// cosine and sine of each phase. The shader rebuilds the same curves from them with the
// angle-sum identities, without a single trigonometric call (same pixels, measured).
function updateRibbonPhases() {
    const time = shaderUniforms.uTime.value * 0.065, s = shaderUniforms.uScroll.value;
    shaderUniforms.uRibbonPhase.value.forEach((phase, k) => {
        const contour = s * 5.0 + k * 0.28, arc = k * 0.55 + s * 3.5;
        phase.set(Math.cos(contour), Math.sin(contour), Math.cos(arc), Math.sin(arc));
    });
    shaderUniforms.uRibbonLift.value.set(0.012 * Math.sin(time), 0.012 * Math.sin(time + 1), 0.012 * Math.sin(time + 2));
    shaderUniforms.uWave.value.set(Math.cos(time), Math.sin(time));
}
updateRibbonPhases();

let sparkParticles;
const sparkCount = 320;
const sparkData = [];
const sugarDrops = [];   // small blown-sugar spheres drifting around the flame

// width × height: the canvas, sized to the tallest viewport (CSS 100lvh). visible: the
// height actually on screen, which the camera composes for; view: the same, eased.
const sizes = { width: window.innerWidth, height: window.innerHeight,
                visible: window.innerHeight, view: window.innerHeight };

const V2 = (x = 0, y = 0) => new THREE.Vector2(x, y);
const cross2 = (a, b) => a.x * b.y - a.y * b.x;
const lerp = THREE.MathUtils.lerp;


function createSparkTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.85)');
    gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 16, 16);
    return new THREE.CanvasTexture(canvas);
}

function createSparks() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(sparkCount * 3);
    const colors = new Float32Array(sparkCount * 3);

    for (let i = 0; i < sparkCount; i++) {
        const x = (Math.random() - 0.5) * 6.5;
        const y = (Math.random() - 0.5) * 5.0 - 0.5;
        const z = (Math.random() - 0.5) * 6.5;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        // Caramel shards and golden sugar dust rising in the warm air of the torch.
        const tone = new THREE.Color(Math.random() < 0.55 ? BRAND.caramel
            : Math.random() < 0.6 ? BRAND.coeur : BRAND.caramelFonce);
        colors[i * 3] = tone.r;
        colors[i * 3 + 1] = tone.g;
        colors[i * 3 + 2] = tone.b;

        sparkData.push({
            speedX: (Math.random() - 0.5) * 0.4,
            speedY: 0.15 + Math.random() * 0.3,
            speedZ: (Math.random() - 0.5) * 0.4,
            swaySpeed: 0.5 + Math.random() * 1.5,
            swayRadius: 0.05 + Math.random() * 0.15,
            phase: Math.random() * Math.PI * 2
        });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Normal blending: on crème, additive light would vanish; caramel specks must read.
    const material = new THREE.PointsMaterial({
        size: 0.03,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        map: createSparkTexture()
    });

    sparkParticles = new THREE.Points(geometry, material);
    scene.add(sparkParticles);
}

// Procedural studio environment: a pastry kitchen. A wide warm lamp overhead, amber
// strips around, a chocolate room: reflections stay golden, never cold or blue.
// It lights the glass without replacing the scrolling background.
function createGlassEnvironment() {
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(BRAND.brun);
    const panels = [
        [6.0, 2.2, 0, 6, 0.6, BRAND.reflet, 2.2],      // the pastry lamp, straight above
        [2.6, 7, -4, 2, 3, BRAND.creme, 1.5],
        [0.6, 7, 3, 1, 2, BRAND.reflet, 2.4],
        [5, 0.6, 0, 5, -1, BRAND.creme, 1.8],
        [0.5, 6, -2, 0, -4, BRAND.coeur, 1.4],
        [1.0, 5, 3, -1, -3, BRAND.caramel, 1.6],
        [4, 0.35, 0, -3, 3, BRAND.coeur, 1.0],
        [0.16, 5, -3, 0, 2, BRAND.reflet, 3.0],
        [0.35, 4, 4, 0, -2, BRAND.coeur, 1.6]
    ];
    for (const [w, h, x, y, z, color, intensity] of panels) {
        const panel = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color(color).multiplyScalar(intensity),
                side: THREE.DoubleSide
            })
        );
        panel.position.set(x, y, z);
        panel.lookAt(0, 0, 0);
        studio.add(panel);
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(studio, 0.025, 0.1, 100);
    scene.environment = environment.texture;
    studio.traverse(object => {
        if (object.isMesh) {
            object.geometry.dispose();
            object.material.dispose();
        }
    });
    pmrem.dispose();
}

// Cooked sugar, not cold glass: crème-tinted transmission, absorbed toward amber in
// the thick of the body like a caramel shard, glossy as a fresh glaze. No iridescence
// and no chromatic dispersion: both read blue, and dispersion tripled the refraction
// cost of every glass pixel.
function createGlassMaterial() {
    const glass = new THREE.MeshPhysicalMaterial({
        color: BRAND.creme,
        metalness: 0.0,
        roughness: 0.018,      // low: the refraction mip level follows it, so the sugar reads sharp
        transmission: 1.0,
        thickness: 0.62,
        ior: 1.50,
        attenuationColor: new THREE.Color(BRAND.caramel),
        attenuationDistance: 2.1,
        specularColor: new THREE.Color(BRAND.reflet),
        clearcoat: 0.9,
        clearcoatRoughness: 0.03,
        iridescence: 0.0,
        envMapIntensity: 1.25,
        side: THREE.DoubleSide
    });
    return glass;
}

// Blown-sugar spheres: a handful of small caramel bubbles hovering near the flame.
// They live in the pivot, so they follow the object into the contact chapter.
function createSugarDrops() {
    // Same sugar glass, absorbed faster: at this size the amber would otherwise wash out.
    const glass = createGlassMaterial();
    glass.attenuationDistance = 0.16;
    glass.color.set(BRAND.reflet);
    glass.side = THREE.FrontSide;
    const geometry = new THREE.SphereGeometry(1, 48, 32);
    const drops = [
        [1.42, -1.05, 0.55, 0.17], [-1.30, 0.55, -0.35, 0.11],
        [1.18, 1.18, -0.55, 0.075], [-1.05, -1.32, 0.45, 0.13]
    ];
    drops.forEach(([x, y, z, r], index) => {
        const mesh = new THREE.Mesh(geometry, glass);
        mesh.scale.setScalar(r);
        mesh.position.set(x, y, z);
        modelPivot.add(mesh);
        sugarDrops.push({ mesh, home: mesh.position.clone(), phase: index * 1.7, speed: 0.55 + index * 0.12 });
    });
}

function updateSugarDrops(time, separation) {
    for (const drop of sugarDrops) {
        const bob = reducedMotion ? 0 : Math.sin(time * drop.speed + drop.phase) * 0.07;
        const spread = 1 + separation * 0.55;   // they make room while the flame breaks apart
        drop.mesh.position.set(drop.home.x * spread, drop.home.y * spread + bob, drop.home.z);
    }
}

// ---- 2D contour helpers ------------------------------------------------------

// Remove near-duplicate and collinear vertices, force counter-clockwise order.
function cleanContour(points, epsilon = 1e-4) {
    const contour = [];
    for (const p of points) {
        if (!contour.length || contour[contour.length - 1].distanceTo(p) > epsilon) contour.push(p.clone());
    }
    while (contour.length > 1 && contour[0].distanceTo(contour[contour.length - 1]) <= epsilon) contour.pop();
    const result = contour.filter((p, i) => {
        const prev = contour[(i - 1 + contour.length) % contour.length];
        const next = contour[(i + 1) % contour.length];
        return Math.abs(cross2(p.clone().sub(prev), next.clone().sub(p))) > 1e-7;
    });
    if (THREE.ShapeUtils.isClockWise(result)) result.reverse();
    return result;
}

// Sutherland-Hodgman clipping against a convex set of half-planes.
function clipContour(points, halfPlanes) {
    let polygon = points.map(p => p.clone());
    for (const { origin, normal } of halfPlanes) {
        const clipped = [];
        for (let i = 0; i < polygon.length; i++) {
            const p = polygon[i], q = polygon[(i + 1) % polygon.length];
            const dp = p.clone().sub(origin).dot(normal), dq = q.clone().sub(origin).dot(normal);
            if (dp >= 0) clipped.push(p);
            if ((dp >= 0) !== (dq >= 0)) clipped.push(p.clone().lerp(q, dp / (dp - dq)));
        }
        polygon = clipped;
        if (!polygon.length) break;
    }
    return cleanContour(polygon);
}

// Convex sector between two rays (counter-clockwise, less than 180 degrees apart).
function wedgeHalfPlanes(center, startDeg, endDeg) {
    const dir = deg => V2(Math.cos(THREE.MathUtils.degToRad(deg)), Math.sin(THREE.MathUtils.degToRad(deg)));
    const a = dir(startDeg), b = dir(endDeg);
    return [{ origin: center, normal: V2(-a.y, a.x) }, { origin: center, normal: V2(b.y, -b.x) }];
}

// Local contour around the bounding-box centre, plus that centre as a home position.
function recentre(points) {
    const centre = new THREE.Box2().setFromPoints(points).getCenter(V2());
    return {
        contour: points.map(p => p.clone().sub(centre)),
        home: new THREE.Vector3(centre.x, centre.y, 0)
    };
}

// Final shape: outline plus its holes, each scaled by holeScale (0 = not punched yet).
function makeIconPrism(bevelSize, bevelThickness, holeScale) {
    const shape = new THREE.Shape(iconOutline);
    if (holeScale > 0.02) {
        for (const hole of iconHoles) {
            const centre = new THREE.Box2().setFromPoints(hole).getCenter(V2());
            shape.holes.push(new THREE.Path(hole.map(p =>
                p.clone().sub(centre).multiplyScalar(holeScale).add(centre))));
        }
    }
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: ICON_DEPTH, steps: 1, bevelEnabled: true, bevelSize, bevelThickness,
        bevelSegments: 6, curveSegments: 24
    });
    geometry.translate(0, 0, -ICON_DEPTH / 2);
    return geometry;
}


function makePrism(points, depth, bevelSize, bevelThickness, bevelSegments = 6) {
    const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points), {
        depth, steps: 1, bevelEnabled: true, bevelSize, bevelThickness,
        bevelSegments, curveSegments: 24
    });
    geometry.translate(0, 0, -depth / 2);
    return geometry;
}

// ---- Morph correspondence ----------------------------------------------------

// Radial matching around each polygon's visibility kernel: fold-free morphs
// for star-shaped fragments. Throws when a kernel does not exist.
function matchRadially(source, target) {
    const prepare = points => {
        const contour = points.filter((p, i) => i === 0 || p.distanceToSquared(points[i - 1]) > 1e-12);
        if (contour[0].distanceToSquared(contour[contour.length - 1]) < 1e-12) contour.pop();
        if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
        let kernel = [V2(-10, -10), V2(10, -10), V2(10, 10), V2(-10, 10)];
        for (let i = 0; i < contour.length; i++) {
            const a = contour[i], edge = contour[(i + 1) % contour.length].clone().sub(a);
            const clipped = [];
            for (let j = 0; j < kernel.length; j++) {
                const p = kernel[j], q = kernel[(j + 1) % kernel.length];
                const dp = cross2(edge, p.clone().sub(a)), dq = cross2(edge, q.clone().sub(a));
                if (dp >= -1e-10) clipped.push(p);
                if ((dp >= 0) !== (dq >= 0)) clipped.push(p.clone().lerp(q, dp / (dp - dq)));
            }
            kernel = clipped;
        }
        if (!kernel.length) throw new Error('Contour has no visibility kernel.');
        const center = kernel.reduce((sum, p) => sum.add(p), V2()).multiplyScalar(1 / kernel.length);
        return { contour, center };
    };
    const a = prepare(source), b = prepare(target);
    const angle = (p, center) => (Math.atan2(p.y - center.y, p.x - center.x) + Math.PI * 2) % (Math.PI * 2);
    const angles = [...a.contour.map(p => angle(p, a.center)), ...b.contour.map(p => angle(p, b.center)),
        ...Array.from({ length: 32 }, (_, i) => i / 32 * Math.PI * 2)].sort((x, y) => x - y)
        .filter((value, i, values) => i === 0 || value - values[i - 1] > 1e-8);
    const sample = ({ contour, center }, angle) => {
        const direction = V2(Math.cos(angle), Math.sin(angle));
        let distance = Infinity;
        for (let i = 0; i < contour.length; i++) {
            const p = contour[i], edge = contour[(i + 1) % contour.length].clone().sub(p);
            const denominator = cross2(direction, edge);
            if (Math.abs(denominator) < 1e-12) continue;
            const relative = p.clone().sub(center);
            const t = cross2(relative, edge) / denominator;
            const u = cross2(relative, direction) / denominator;
            if (t >= 0 && u >= -1e-8 && u <= 1 + 1e-8) distance = Math.min(distance, t);
        }
        if (!isFinite(distance)) throw new Error('Ray missed the contour.');
        return center.clone().addScaledVector(direction, distance);
    };
    return angles.map(angle => ({ source: sample(a, angle), target: sample(b, angle) }));
}

// Fallback for arbitrary polygons: equal arc-length resampling with the best
// rotational alignment. Works for any simple contour, may fold on wild shapes.
function matchByArcLength(source, target, samples = 160) {
    const resample = points => {
        const lengths = [0];
        for (let i = 0; i < points.length; i++) {
            lengths.push(lengths[i] + points[i].distanceTo(points[(i + 1) % points.length]));
        }
        const total = lengths[points.length];
        const out = [];
        let segment = 0;
        for (let i = 0; i < samples; i++) {
            const d = i / samples * total;
            while (segment < points.length - 1 && lengths[segment + 1] < d) segment++;
            const p = points[segment], q = points[(segment + 1) % points.length];
            const span = lengths[segment + 1] - lengths[segment];
            out.push(p.clone().lerp(q, span > 0 ? (d - lengths[segment]) / span : 0));
        }
        return out;
    };
    const a = resample(source), b = resample(target);
    let best = 0, bestCost = Infinity;
    for (let k = 0; k < samples; k++) {
        let cost = 0;
        for (let i = 0; i < samples; i++) cost += a[i].distanceToSquared(b[(i + k) % samples]);
        if (cost < bestCost) { bestCost = cost; best = k; }
    }
    return a.map((p, i) => ({ source: p, target: b[(i + best) % samples] }));
}

function matchMorphContours(source, target, name) {
    try {
        return matchRadially(source, target);
    } catch (error) {
        console.warn(`[glass] radial morph unavailable for "${name}" (${error.message}); using arc-length matching.`);
        return matchByArcLength(source, target);
    }
}

// ---- Reading a shape ---------------------------------------------------------
// Any SVG works. The largest contour is the outline; contours inside it are holes;
// anything else is a separate solid (the leaf of an apple, the dot of an i).
function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function parseShape(svgText) {
    const svg = new SVGLoader().parse(svgText);
    const contours = svg.paths
        .flatMap(path => path.subPaths.map(sub => cleanContour(sub.getPoints(6).map(p => V2(p.x, -p.y)))))
        .filter(contour => contour.length >= 3 && Math.abs(THREE.ShapeUtils.area(contour)) > 1e-9)
        .sort((a, b) => Math.abs(THREE.ShapeUtils.area(b)) - Math.abs(THREE.ShapeUtils.area(a)));
    if (!contours.length) throw new Error('This SVG has no closed contour.');
    const [outline, ...rest] = contours;
    const holes = [], extras = [];
    for (const contour of rest) {
        const centre = new THREE.Box2().setFromPoints(contour).getCenter(V2());
        (pointInPolygon(centre, outline) ? holes : extras).push(contour);
    }
    return { outline, holes, extras };
}

// Centre a shape on the origin and scale it to `height` world units.
function fitShape(shape, height) {
    const bounds = new THREE.Box2().setFromPoints(
        [shape.outline, ...shape.holes, ...shape.extras].flat());
    const centre = bounds.getCenter(V2());
    const size = bounds.getSize(V2());
    const scale = height / Math.max(size.x, size.y);
    const fit = contour => contour.map(p => p.clone().sub(centre).multiplyScalar(scale));
    return { outline: fit(shape.outline), holes: shape.holes.map(fit), extras: shape.extras.map(fit) };
}

// Visibility kernel of a polygon: from any point of it the whole contour is visible.
// A non-empty kernel is what makes the radial morph fold-free.
function visibilityKernel(points) {
    const contour = points.slice();
    if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
    const span = new THREE.Box2().setFromPoints(contour).getSize(V2()).length() * 2 + 1;
    let kernel = [V2(-span, -span), V2(span, -span), V2(span, span), V2(-span, span)];
    for (let i = 0; i < contour.length; i++) {
        const a = contour[i];
        const edge = contour[(i + 1) % contour.length].clone().sub(a);
        const clipped = [];
        for (let j = 0; j < kernel.length; j++) {
            const p = kernel[j], q = kernel[(j + 1) % kernel.length];
            const dp = cross2(edge, p.clone().sub(a)), dq = cross2(edge, q.clone().sub(a));
            if (dp >= -1e-10) clipped.push(p);
            if ((dp >= 0) !== (dq >= 0)) clipped.push(p.clone().lerp(q, dp / (dp - dq)));
        }
        kernel = clipped;
        if (!kernel.length) return [];
    }
    return kernel;
}

// Cut a contour into `count` radial fragments. The start angle is chosen by scanning:
// the winner is the split whose worst fragment has the largest visibility kernel, so
// the morph stays fold-free on shapes this code has never seen.
function partitionContour(outline, count) {
    if (count <= 1) return [outline];
    const centre = new THREE.Box2().setFromPoints(outline).getCenter(V2());
    const step = 360 / count;
    let best = null;
    for (let offset = 0; offset < step - 0.001; offset += 5) {
        const pieces = [];
        let worst = Infinity;
        for (let i = 0; i < count; i++) {
            const piece = clipContour(outline,
                wedgeHalfPlanes(centre, offset + i * step, offset + (i + 1) * step));
            if (piece.length < 3) { worst = -1; break; }
            const kernel = visibilityKernel(piece);
            const ratio = kernel.length
                ? Math.abs(THREE.ShapeUtils.area(kernel)) / Math.abs(THREE.ShapeUtils.area(piece)) : 0;
            worst = Math.min(worst, ratio);
            pieces.push(piece);
        }
        if (worst >= 0 && (!best || worst > best.worst)) best = { worst, pieces };
    }
    if (!best) throw new Error(`Could not split this shape into ${count} fragments.`);
    if (best.worst === 0) {
        console.warn('[glass] a fragment has no visibility kernel; using arc-length morphing there.');
    }
    return best.pieces;
}

// Fragments of a fitted shape: radial wedges of the outline plus any separate solids,
// ordered by angle so both shapes are matched fragment to fragment along short paths.
function shapeFragments(fit, count) {
    const wedges = Math.max(1, count - fit.extras.length);
    // Separate solids are tagged: they stay visible while the outline is assembled.
    const extras = fit.extras.map(contour => Object.assign(contour.slice(), { isExtra: true }));
    const pieces = [...partitionContour(fit.outline, wedges), ...extras].slice(0, Math.max(1, count));
    const angle = contour => {
        const c = new THREE.Box2().setFromPoints(contour).getCenter(V2());
        return (Math.atan2(c.y, c.x) + Math.PI * 2) % (Math.PI * 2);
    };
    return pieces.sort((a, b) => angle(a) - angle(b));
}

// ---- Building the two glass shapes -------------------------------------------
function createGlassLogo() {
    createGlassEnvironment();
    modelPivot = new THREE.Group();
    modelPivot.position.y = -0.3;
    scene.add(modelPivot);

    const glass = createGlassMaterial();
    const logo = new THREE.Group();
    logo.rotation.set(-0.08, 0.28, -0.08);
    modelPivot.add(logo);
    createSugarDrops();

    const opening = fitShape(parseShape(openingSource), LOGO_HEIGHT);
    const final = fitShape(parseShape(finalSource), ICON_SIZE);
    iconOutline = final.outline;
    iconHoles = final.holes;

    // Assembled opening shape: one watertight prism, holes included, so the mark is
    // exact before it breaks apart. Fragments ignore holes while they are separated.
    const whole = recentre(opening.outline);
    const wholeShape = new THREE.Shape(whole.contour);
    const wholeOffset = V2(whole.home.x, whole.home.y);
    for (const hole of opening.holes) {
        wholeShape.holes.push(new THREE.Path(hole.map(p => p.clone().sub(wholeOffset))));
    }
    const wholeGeometry = new THREE.ExtrudeGeometry(wholeShape, {
        depth: LOGO_DEPTH, steps: 1, bevelEnabled: true,
        bevelSize: LOGO_BEVEL.size, bevelThickness: LOGO_BEVEL.thickness,
        bevelSegments: 6, curveSegments: 24
    });
    wholeGeometry.translate(0, 0, -LOGO_DEPTH / 2);
    wholeBody = new THREE.Mesh(wholeGeometry, glass);
    wholeBody.position.copy(whole.home);
    logo.add(wholeBody);

    // Final watertight prism: bevels grow and holes open once the fragments merge.
    glassIcon = new THREE.Mesh(makeIconPrism(SEAM_BEVEL, SEAM_BEVEL, 0), glass);
    glassIcon.userData.progress = -1;
    glassIcon.visible = false;
    logo.add(glassIcon);

    const sources = shapeFragments(opening, SITE.fragments);
    const targets = shapeFragments(final, sources.length);
    sources.forEach((sourceContour, index) => {
        const isExtra = !!sourceContour.isExtra;
        const source = recentre(sourceContour);
        const target = recentre(targets[Math.min(index, targets.length - 1)]);
        const geometry = makePrism(source.contour, LOGO_DEPTH, LOGO_BEVEL.size, LOGO_BEVEL.thickness);
        const mesh = new THREE.Mesh(geometry, glass);
        mesh.position.copy(source.home);
        logo.add(mesh);
        const radial = V2(source.home.x, source.home.y);
        if (radial.lengthSq() < 1e-6) radial.set(Math.cos(index), Math.sin(index));
        const offset = new THREE.Vector3(radial.x, radial.y, 0).normalize().multiplyScalar(1.15);
        offset.z = (index % 2 === 0 ? 1 : -1) * 0.55;
        const side = Math.sign(offset.x) || 1, vertical = Math.sign(offset.y) || 1;
        logoPieces.push({
            name: `fragment-${index}`, mesh, home: source.home, offset,
            twist: new THREE.Vector3(vertical * 0.12, side * 0.18, -side * vertical * 0.09),
            targetHome: target.home,
            correspondence: matchMorphContours(source.contour, target.contour, `fragment-${index}`),
            originalGeometry: geometry, morphGeometry: null, isBody: !isExtra,
            // A separate solid never merges into the outline: it keeps its own final prism.
            finalGeometry: isExtra ? makePrism(target.contour, ICON_DEPTH, ICON_BEVEL.size, ICON_BEVEL.thickness) : null,
            targetContour: isExtra ? target.contour : null, extraBevel: -1
        });
    });
}


// ---- Liquid glass card: a transmissive slab pinned to the DOM card ----------
// The slab lives in camera space at a fixed distance, so CSS pixels map linearly
// to world units. Its refraction, blur and rim lensing are real: the background
// shader is bent through the bevelled edge, like Apple's Liquid Glass.
function roundedRectShape(w, h, r) {
    const shape = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(x + w, y + h - r);
    shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    shape.lineTo(x + r, y + h);
    shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(x, y + r);
    shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return shape;
}

function cardUnitsPerPixel() {
    return 2 * CARD_DISTANCE * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / sizes.view;
}

function buildGlassCardGeometry(w, h, unitsPerPixel) {
    const rim = CARD_RIM_PX * unitsPerPixel;                  // refractive rim width
    const radius = Math.max(rim + 0.002, CARD_RADIUS_PX * unitsPerPixel);
    const shape = roundedRectShape(w - 2 * rim, h - 2 * rim, radius - rim);
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: CARD_DEPTH, steps: 1, bevelEnabled: true, bevelSize: rim, bevelThickness: CARD_RIM_DEPTH,
        bevelSegments: 10, curveSegments: 18
    });
    geometry.translate(0, 0, -(CARD_DEPTH + CARD_RIM_DEPTH));   // front face at local z = 0
    return geometry;
}

function createGlassCard() {
    if (!contactCardElement) return;
    // Frosted caramel variant of the sugar glass: dims what shows through for legible
    // crème text, blurs the background, and the bevelled rim still bends light like a lens.
    cardGlass = createGlassMaterial();
    cardGlass.side = THREE.FrontSide;
    cardGlass.color.set(BRAND.reflet);
    cardGlass.roughness = 0.36;
    cardGlass.thickness = 0.35;
    cardGlass.attenuationColor.set(BRAND.caramelFonce);
    cardGlass.attenuationDistance = 0.9;
    cardGlass.clearcoat = 1.0;
    cardGlass.clearcoatRoughness = 0.14;
    cardGlass.envMapIntensity = 0.45;
    glassCard = new THREE.Mesh(buildGlassCardGeometry(1, 1, 1), cardGlass);
    glassCard.userData = { w: 0, h: 0 };
    glassCard.visible = false;
    camera.add(glassCard);
    document.body.classList.add('has-glass-card');
}

// Pin the slab to the live DOM rectangle of the card (rebuilt only when its size changes).
function updateGlassCard() {
    if (!glassCard || !contactCardElement) return;
    glassCard.visible = targetContact > 0.001;
    if (!glassCard.visible) return;
    const rect = contactCardElement.getBoundingClientRect();
    const upp = cardUnitsPerPixel();
    const w = rect.width * upp, h = rect.height * upp;
    if (Math.abs(glassCard.userData.w - w) > 0.003 || Math.abs(glassCard.userData.h - h) > 0.003) {
        glassCard.geometry.dispose();
        glassCard.geometry = buildGlassCardGeometry(w, h, upp);
        glassCard.userData = { w, h };
    }
    const cx = rect.left + rect.width / 2 - sizes.width / 2;
    const cy = sizes.view / 2 - (rect.top + rect.height / 2);
    glassCard.position.set(cx * upp, cy * upp, -CARD_DISTANCE);
    // A whisper of parallax so the highlights travel with the pointer.
    glassCard.rotation.set(-mouseY * 0.02, mouseX * 0.025, 0);
}

// The cinematic runs over the scroll stage only; the contact section follows it.
function stageMaxScroll() {
    const height = stageElement ? stageElement.offsetHeight : document.documentElement.scrollHeight;
    return Math.max(1, height - window.innerHeight);
}

function smoothScrollRange(scroll, start, end) {
    const t = THREE.MathUtils.clamp((scroll - start) / (end - start), 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
}

// ---- Free zones: on short phone screens the object fits the room the text leaves ----
// The portrait framing below is tuned for a tall phone (375 × 812). With the browser bars
// showing (iPhone: 664 px, 548 on an SE) the text blocks take most of the height, so for
// each chapter the band they leave free is measured on resize, and the camera backs away
// and re-aims whenever the object would spill out of it. When it fits, nothing changes.
const FREE_ZONE_GAP = 4;
const freeZones = [];
function measureFreeZones() {
    const header = document.querySelector('.main-header');
    const headerBottom = header ? header.offsetTop + header.offsetHeight : 0;
    for (let i = 0; i < 4; i++) {
        const slide = document.getElementById(`slide-${i + 1}`);
        if (!slide) { freeZones.length = 0; return; }
        const top = slide.offsetTop, bottom = top + slide.offsetHeight;
        // Text on top for chapters 1 and 3 (the object below it, down to the screen
        // edge; the hero's scroll cue may overlay it), at the bottom for 2 and 4.
        freeZones[i] = i % 2 === 0
            ? [bottom + FREE_ZONE_GAP, sizes.visible - (i === 0 ? 0 : 12)]
            : [headerBottom + FREE_ZONE_GAP, top - FREE_ZONE_GAP];
    }
}

// Vertical extent on screen (CSS px) of the glass object for a given camera placement.
const fitCamera = new THREE.PerspectiveCamera();
const fitCorner = new THREE.Vector3();
function objectScreenExtent(position, lookAt) {
    fitCamera.copy(camera, false);
    fitCamera.position.copy(position);
    fitCamera.lookAt(lookAt);
    fitCamera.updateMatrixWorld();
    modelPivot.updateMatrixWorld(true);
    let top = Infinity, bottom = -Infinity;
    for (const mesh of [wholeBody, glassIcon, ...logoPieces.map(piece => piece.mesh)]) {
        if (!mesh || !mesh.visible) continue;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const { min, max } = mesh.geometry.boundingBox;
        for (let corner = 0; corner < 8; corner++) {
            fitCorner.set(corner & 1 ? max.x : min.x, corner & 2 ? max.y : min.y, corner & 4 ? max.z : min.z)
                .applyMatrix4(mesh.matrixWorld).project(fitCamera);
            const y = (1 - fitCorner.y) / 2 * sizes.height;
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
        }
    }
    return [top, bottom];
}

// Camera framing. Landscape: orbit close, object pushed sideways to clear the text
// columns. Portrait (phones, tablets): orbit further out and stack vertically, the
// object taking the lower half on slides 1 and 3 and the upper half on 2 and 4.
function cameraFrame(scroll) {
    const aspect = sizes.width / sizes.view;
    const portrait = THREE.MathUtils.clamp((1.0 - aspect) / 0.2, 0, 1);
    const separation = getLogoSeparation(scroll);
    const morph = smoothScrollRange(scroll, 0.40, 0.54);
    const landscapeRadius = 4.7 - Math.sin(scroll * Math.PI) * 0.6 + separation * 2.6 + morph * 0.9;
    // Opening screen on phones: the text panel (with the tool logos) is tall, so the
    // flame starts a little smaller and lower, and grows back as soon as you scroll.
    const hero = 1 - smoothScrollRange(scroll, 0.03, 0.14);
    // One weight per chapter.
    const ch1 = 1 - smoothScrollRange(scroll, 0.12, 0.24);
    const ch2 = smoothScrollRange(scroll, 0.12, 0.24) - smoothScrollRange(scroll, 0.40, 0.50);
    const ch3 = smoothScrollRange(scroll, 0.52, 0.62) - smoothScrollRange(scroll, 0.74, 0.86);
    const ch4 = smoothScrollRange(scroll, 0.74, 0.86);
    // Chapter 2 on phones: the about card is the tallest text block, so the scattered
    // fragments sit a little smaller and higher to stay clear of its title.
    const portraitRadius = 10.4 - Math.sin(scroll * Math.PI) * 0.4 + separation * 5.2 + morph * 0.4
        + hero * 4.2 + ch2 * 1.2;
    let radius = lerp(landscapeRadius, portraitRadius, portrait);
    // Landscape: shift the object sideways so it never sits under a text block.
    // Negative pushes the object right (text on the left).
    const x = (-1.5 * ch1 + 1.5 * ch2 - 1.8 * ch3 - 1.4 * ch4) * (1 - portrait);
    // Portrait: +1 puts the object low on screen, -1 high; alternates per chapter.
    const stack = 1 - 2 * smoothScrollRange(scroll, 0.16, 0.26)
        + 2 * smoothScrollRange(scroll, 0.44, 0.54)
        - 2 * smoothScrollRange(scroll, 0.72, 0.82);
    const visibleHeight = 2 * radius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Object centre at 70 % of the height when low, 31 % when high (clear of the header).
    const y = -0.15 + portrait * (stack * (stack > 0 ? 0.225 + hero * 0.06 : 0.195) - ch2 * 0.03) * visibleHeight;
    // Screen-right axis for this orbit position (camera looks at the origin).
    const phi = scroll * Math.PI * 2.0;
    const right = new THREE.Vector3(Math.cos(phi), 0, -Math.sin(phi));
    const lookAt = new THREE.Vector3(0, y, 0).addScaledVector(right, x);

    // Short screens: keep the object inside the free zone of the chapter(s) on screen.
    if (portrait > 0 && freeZones.length === 4 && modelPivot) {
        const a = smoothScrollRange(scroll, 0.16, 0.26), b = smoothScrollRange(scroll, 0.44, 0.54);
        const c = smoothScrollRange(scroll, 0.72, 0.82);
        const weights = [1 - a, a - b, b - c, c];
        const zoneTop = weights.reduce((sum, w, i) => sum + w * freeZones[i][0], 0);
        const zoneBottom = weights.reduce((sum, w, i) => sum + w * freeZones[i][1], 0);
        const position = new THREE.Vector3(radius * Math.sin(phi),
            0.35 + Math.sin(scroll * Math.PI) * 0.8, radius * Math.cos(phi));
        const [top, bottom] = objectScreenExtent(position, lookAt);
        // Backing away shrinks the object around the screen centre; then nudge the aim
        // so it sits inside the zone (a higher aim lowers the object on screen).
        const centre = sizes.view / 2;
        const scale = Math.min(1, (zoneBottom - zoneTop) / Math.max(1, bottom - top));
        const fittedTop = centre + (top - centre) * scale, fittedBottom = centre + (bottom - centre) * scale;
        const shift = fittedTop < zoneTop ? zoneTop - fittedTop
            : fittedBottom > zoneBottom ? zoneBottom - fittedBottom : 0;
        const fittedRadius = radius / scale;
        const worldPerPixel = 2 * fittedRadius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / sizes.view;
        lookAt.y += shift * worldPerPixel * portrait;
        radius = lerp(radius, fittedRadius, portrait);
    }
    return { radius, lookAt, portrait };
}

function getLogoSeparation(scroll) {
    return smoothScrollRange(scroll, 0.12, 0.28) * (1 - smoothScrollRange(scroll, 0.40, 0.54));
}

// Geometry rebuilds are paid on the CPU: on a first visit, reshaping every fragment in
// the same frame costs 4 to 16 ms on a laptop, several times that on a phone. Each frame
// gets a small budget; a fragment left out keeps its previous shape for a frame or two,
// which does not show in motion, and goes first on the next frame.
const REBUILD_BUDGET_MS = 3;
let rebuildCursor = 0;
function rebuildBudget() {
    const start = performance.now();
    let builds = 0;
    return () => builds++ === 0 || performance.now() - start < REBUILD_BUDGET_MS;
}

// Returns null, and builds nothing, when the key is not cached and the budget is spent.
function cachedGeometry(owner, key, build, allowBuild) {
    const cache = owner.geometryCache || (owner.geometryCache = new Map());
    let geometry = cache.get(key);
    if (geometry) cache.delete(key);
    else if (allowBuild && !allowBuild()) return null;
    else geometry = build();
    cache.set(key, geometry);
    if (cache.size > 24) {
        const oldest = cache.keys().next().value;
        cache.get(oldest).dispose();
        cache.delete(oldest);
    }
    return geometry;
}
const geometryStep = value => Math.round(value * 96) / 96;

function updateLogoPieces(scroll) {
    const separation = getLogoSeparation(scroll);
    const morph = smoothScrollRange(scroll, 0.40, 0.54);
    const geometryMorph = geometryStep(morph);
    const complete = morph >= 1;
    const assembled = separation <= 0 && morph <= 0;
    const allowBuild = rebuildBudget();
    if (wholeBody) wholeBody.visible = assembled;
    if (glassIcon) {
        glassIcon.visible = complete;
        if (complete) {
            const bevel = geometryStep(smoothScrollRange(scroll, 0.54, 0.56));
            const hole = geometryStep(smoothScrollRange(scroll, 0.54, 0.60));
            const key = `${bevel}:${hole}`;
            if (key !== glassIcon.userData.progress) {
                // The finished shape is the one on screen: it takes the frame's first build.
                const geometry = cachedGeometry(glassIcon, key, () => makeIconPrism(
                    lerp(SEAM_BEVEL, ICON_BEVEL.size, bevel),
                    lerp(SEAM_BEVEL, ICON_BEVEL.thickness, bevel), hole), allowBuild);
                if (geometry) {
                    if (glassIcon.userData.progress === -1) glassIcon.geometry.dispose();
                    glassIcon.geometry = geometry;
                    glassIcon.userData.progress = key;
                }
            }
        }
    }
    const count = logoPieces.length;
    let firstSkipped = -1;
    for (let step = 0; step < count; step++) {
        const index = (rebuildCursor + step) % count;
        const piece = logoPieces[index];
        const { mesh, home, targetHome, offset, twist, correspondence } = piece;
        mesh.visible = piece.isBody ? !complete && !assembled : true;
        mesh.position.copy(home).lerp(targetHome, morph).addScaledVector(offset, separation);
        mesh.rotation.set(twist.x * separation, twist.y * separation, twist.z * separation);
        if (!mesh.visible) continue;
        let geometry;
        if (!piece.isBody && complete) {
            const bevel = geometryStep(smoothScrollRange(scroll, 0.54, 0.56));
            geometry = bevel >= 1 ? piece.finalGeometry : cachedGeometry(piece, `extra:${bevel}`,
                () => makePrism(piece.targetContour, ICON_DEPTH,
                    lerp(SEAM_BEVEL, ICON_BEVEL.size, bevel),
                    lerp(SEAM_BEVEL, ICON_BEVEL.thickness, bevel)), allowBuild);
        } else if (morph <= 0) {
            geometry = piece.originalGeometry;
        } else {
            geometry = cachedGeometry(piece, `morph:${geometryMorph}`, () => {
                const contour = correspondence.map(({source, target}) => source.clone().lerp(target, geometryMorph));
                // Rebuilt on the fly while the fragments travel: three bevel rings are
                // enough in motion and halve the cost of each rebuild.
                return makePrism(contour, lerp(LOGO_DEPTH, ICON_DEPTH, geometryMorph),
                    lerp(LOGO_BEVEL.size, SEAM_BEVEL, geometryMorph),
                    lerp(LOGO_BEVEL.thickness, SEAM_BEVEL, geometryMorph), 3);
            }, allowBuild);
        }
        if (geometry) mesh.geometry = geometry;
        else if (firstSkipped < 0) firstSkipped = index;
    }
    if (firstSkipped >= 0) rebuildCursor = firstSkipped;
}


function createBackgroundShader() {
    const vertexShader = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    const fragmentShader = `
        varying vec2 vUv;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform vec2 uMouse;
        uniform float uScroll;
        uniform float uContact;
        uniform float uVelocity;
        uniform vec3 uCreme; uniform vec3 uCreme2; uniform vec3 uBrun; uniform vec3 uReflet;
        // Per ribbon: cos/sin of the contour phase (xy) and of the arc phase (zw).
        uniform vec4 uRibbonPhase[3]; uniform vec3 uRibbonLift; uniform vec2 uWave;

        mat2 rotate2d(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }
        float fineLine(float d, float width) {
            return 1.0 - smoothstep(width, width + 1.5 / uResolution.y, abs(d));
        }
        // Four caramel tints, one per light chapter, and the ember of the dark one,
        // set from SITE.palette. Colours arrive linear; the output is converted below.
        uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform vec3 uC4;
        vec3 chapterTint(float progress) {
            if (progress < 0.34) return mix(uC0, uC1, smoothstep(0.02, 0.32, progress));
            if (progress < 0.62) return mix(uC1, uC2, smoothstep(0.36, 0.60, progress));
            return mix(uC2, uC3, smoothstep(0.66, 0.94, progress));
        }
        void main() {
            vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
            float s = uScroll;
            float time = uTime * 0.065;
            vec3 tint = chapterTint(s);
            vec3 tint2 = chapterTint(min(1.0, s + 0.18));
            float c = smoothstep(0.0, 1.0, uContact);

            // Light stage: crème pâtissière, a touch deeper toward the bottom of the dish,
            // with a caramel glow behind the object that follows it from chapter to chapter.
            vec3 light = mix(uCreme, uCreme2, smoothstep(0.35, -0.70, uv.y) * 0.9);
            vec2 haloUv = (uv - vec2(0.16 + 0.16 * sin(s * 4.0), 0.10)) * vec2(1.05, 1.45);
            light = mix(light, tint, exp(-dot(haloUv, haloUv) * 2.2) * 0.26);
            vec2 lowerUv = (uv + vec2(0.45, 0.34)) * vec2(1.5, 2.4);
            light = mix(light, tint2, exp(-dot(lowerUv, lowerUv) * 2.0) * 0.10);

            // Dark stage (contact): chocolat noir, warmer at the heart, one ember of caramel.
            vec2 heartUv = uv * vec2(0.9, 1.3);
            vec3 dark = mix(uBrun, mix(uBrun, uC4, 0.05), exp(-dot(heartUv, heartUv) * 1.4));
            vec2 emberUv = (uv - vec2(-0.40, 0.28)) * vec2(1.2, 1.6);
            dark = mix(dark, uC4, exp(-dot(emberUv, emberUv) * 2.4) * 0.06);

            // Crème never fades through grey on its way to chocolate: it caramelises first.
            vec3 color = mix(light, dark, c);
            color = mix(color, mix(uC0, uBrun, c * c), 4.0 * c * (1.0 - c) * 0.65);

            // Caramel drizzle: three broad glossy ribbons, a warm reflection on each crest.
            vec2 p = rotate2d(-0.24 + s * 0.65) * (uv - vec2(0.06, -0.08));
            p += uMouse * 0.018;
            p.x += 0.15 * sin(p.y * 2.8 + s * 4.8 + time * 0.3);
            p.y += 0.09 * cos(p.x * 3.1 - s * 3.8 - time * 0.2);
            vec3 ribbonTint = mix(tint, uC4, c);
            for (int i = 0; i < 3; i++) {
                vec2 q = p + vec2(0.0, uRibbonLift[i]);
                float radius = length(q * vec2(0.90, 1.22));
                // A ribbon never strays more than 0.1 from its base radius and fades out
                // within 0.25 of its contour: pixels farther away skip it.
                float base = 0.34 + float(i) * 0.145;
                if (abs(radius - base) > 0.36) continue;
                // (cos a, sin a) of the angle around the centre, then 2a and 3a by the
                // double- and triple-angle formulas: no atan, no sin, no cos.
                vec2 u = q * inversesqrt(max(dot(q, q), 1e-12));
                float cos2 = u.x * u.x - u.y * u.y, sin2 = 2.0 * u.x * u.y;
                float cos3 = u.x * (4.0 * u.x * u.x - 3.0), sin3 = u.y * (3.0 - 4.0 * u.y * u.y);
                vec4 phase = uRibbonPhase[i];
                float contour = base
                    + 0.075 * (sin2 * phase.x + cos2 * phase.y)      // sin(2a + contour phase)
                    + 0.022 * (cos3 * uWave.x + sin3 * uWave.y);     // cos(3a - time)
                float d = radius - contour;
                if (abs(d + 0.01) > 0.25) continue;
                float arc = smoothstep(-0.65, 0.65, u.y * phase.z + u.x * phase.w);   // sin(a + arc phase)
                float body = d * 24.0, shoulder = (d + 0.02) * 12.0;
                color = mix(color, ribbonTint, (exp(-body * body) * 0.17 + exp(-shoulder * shoulder) * 0.05)
                    * arc * (1.0 - c * 0.72));
                color = mix(color, uReflet, fineLine(d + 0.006, 0.0011) * arc
                    * (0.50 + uVelocity * 0.2) * (1.0 - c * 0.7));
            }

            // Soft warm vignette: the edges sink toward toasted caramel, never grey.
            float vignette = smoothstep(0.45, 1.25, length(uv * vec2(0.8, 1.0)));
            color = mix(color, color * mix(vec3(0.90, 0.80, 0.64), vec3(0.72, 0.66, 0.60), c), vignette * 0.4);
            gl_FragColor = vec4(color, 1.0);
            #include <colorspace_fragment>
        }
    `;

    bgMaterial = new THREE.ShaderMaterial({
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        uniforms: shaderUniforms,
        depthWrite: false,
        depthTest: false
    });

    const bgGeometry = new THREE.PlaneGeometry(30, 30);
    bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    bgMesh.position.set(0.0, 0.0, -8.0);   // local camera space, far behind
    bgMesh.renderOrder = -10;
    camera.add(bgMesh);                    // attach to camera so it always fills view
}

// Phones: the browser bars slide in and out while scrolling and change the window height
// each time. Reallocating the canvas then costs a visible hitch (10 ms and more, measured),
// so the canvas keeps the tallest viewport height and only the camera follows the visible
// height. Returns true when the width changed.
function onWindowResize() {
    const width = window.innerWidth;
    const height = Math.max(canvas.clientHeight, window.innerHeight);
    const widthChanged = width !== sizes.width;
    sizes.visible = window.innerHeight;
    if (widthChanged || height !== sizes.height) {
        sizes.width = width;
        sizes.height = height;
        pixelRatio = targetPixelRatio();
        renderer.setDrawingBufferSize(width, height, pixelRatio);
        renderer.getDrawingBufferSize(shaderUniforms.uResolution.value);
    }
    frameCamera();
    measureFreeZones();
    return widthChanged;
}

// The visible part is the top of the canvas: the camera frames it, and the strip below,
// under the browser bar, continues the same view.
function frameCamera() {
    camera.aspect = sizes.width / sizes.view;
    camera.setViewOffset(sizes.width, sizes.view, 0, 0, sizes.width, sizes.height);
}

window.addEventListener('mousemove', (event) => {
    cursorX = event.clientX;
    cursorY = event.clientY;
    const cursorInner = document.querySelector('.cursor-inner');
    if (cursorInner) { cursorInner.style.left = `${cursorX}px`; cursorInner.style.top = `${cursorY}px`; }
    targetMouseX = (event.clientX / window.innerWidth) * 2 - 1;
    targetMouseY = (event.clientY / window.innerHeight) * 2 - 1;
    document.body.classList.remove('cursor-hidden');
});
// Reticle states: expands over links and buttons, becomes a caret over text fields.
document.addEventListener('mouseover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    document.body.classList.toggle('cursor-hover', Boolean(target && target.closest('a, button')));
    document.body.classList.toggle('cursor-text', Boolean(target && target.closest('input, textarea')));
});
document.addEventListener('mouseleave', () => document.body.classList.add('cursor-hidden'));
let cursorLabelText = '';
function updateCursorLabel() {
    const label = document.querySelector('.cursor-label');
    if (!label) return;
    label.style.left = `${outerCursorX}px`;
    label.style.top = `${outerCursorY}px`;
    const text = targetContact > 0.02 ? 'CONTACT' : String(Math.round(currentScroll * 100)).padStart(3, '0');
    if (text !== cursorLabelText) { label.textContent = text; cursorLabelText = text; }
}
window.addEventListener('resize', () => {
    // Titles fit the width: a browser bar changing only the height leaves them alone.
    if (onWindowResize()) { headerState.chapter = -1; fitTitles(); }
});

function splitTitlesIntoLines() {
    document.querySelectorAll('.slide-title').forEach(title => {
        const parts = title.innerHTML.split(/(<br\s*\/?>)/i);
        let html = '', line = 0;
        parts.forEach(part => {
            if (part.toLowerCase().startsWith('<br')) { line++; return; }   // lines are blocks
            // Every line after the first is rendered in muted silver.
            html += `<span class="line${line > 0 ? ' muted' : ''}"><span class="line-inner">${part.trim()}</span></span>`;
        });
        title.innerHTML = html;
    });
}

// A title is two lines, never three: lines do not wrap, and a title whose widest line
// would overflow its column shrinks until it fits. Measured with the loaded font,
// again on resize.
function fitTitles() {
    document.querySelectorAll('.slide-title, .contact-title').forEach(title => {
        title.style.fontSize = '';
        const lines = [...title.querySelectorAll('.line-inner')];
        if (!lines.length) return;
        const widest = Math.max(...lines.map(line => {
            const range = document.createRange();
            range.selectNodeContents(line);
            return range.getBoundingClientRect().width;
        }));
        const available = title.clientWidth;
        if (widest > available && available > 0) {
            const size = parseFloat(getComputedStyle(title).fontSize);
            title.style.fontSize = `${Math.floor(size * available / widest * 0.985)}px`;
        }
    });
    measureFreeZones();   // title sizes set the height of the text blocks
}

let animationRequest = 0;
let lastFrameAt = 0, lastFrameFps = 0;
let lastInputAt = performance.now();
for (const event of ['scroll', 'pointermove', 'pointerdown', 'keydown', 'resize']) {
    window.addEventListener(event, () => { lastInputAt = performance.now(); }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(animationRequest);
    animationRequest = 0;
    if (!document.hidden) {
        clock.getDelta();
        lastFrameAt = 0;
        lastInputAt = performance.now();
        animationRequest = requestAnimationFrame(animate);
    }
});
function animate(now = performance.now()) {
    if (document.hidden) return;
    animationRequest = requestAnimationFrame(animate);
    const unsettled = Math.abs(THREE.MathUtils.clamp(window.scrollY / stageMaxScroll(), 0, 1) - currentScroll) > 0.0001
        || Math.abs(targetContact - currentContact) > 0.0001;
    const fps = unsettled || now - lastInputAt < 1500 ? 60 : 30;
    if (lastFrameAt && now - lastFrameAt < 1000 / fps - 1) return;
    // Only 60 fps stretches say anything about the GPU; the idle 30 fps mode is deliberate.
    // Nor while the fragments are being rebuilt on the CPU (recomposition): resolution
    // would not help there.
    const rebuilding = currentScroll > 0.38 && currentScroll < 0.58;
    if (lastFrameAt && fps === 60 && lastFrameFps === 60 && !rebuilding
        && !document.body.classList.contains('is-loading')) {
        governResolution(now - lastFrameAt);
    }
    lastFrameAt = now;
    lastFrameFps = fps;
    const deltaTime = Math.min(clock.getDelta(), 0.1);
    const damping = factor => 1 - Math.pow(1 - factor, deltaTime * 60);

    // 1. target scroll [0..1] over the stage, then [0..1] into the contact chapter
    const maxScroll = stageMaxScroll();
    const scrollTop = window.scrollY !== undefined ? window.scrollY
        : (window.pageYOffset !== undefined ? window.pageYOffset : document.documentElement.scrollTop);
    const targetScroll = THREE.MathUtils.clamp(scrollTop / maxScroll, 0, 1);
    targetContact = contactSection
        ? THREE.MathUtils.clamp((scrollTop - maxScroll) / window.innerHeight, 0, 1) : 0;

    // smooth physical lerp (inertia); the icon must be whole quickly once the form is reached.
    // Reduced motion: the scene tracks the scroll almost directly, no glide afterwards.
    currentScroll += (targetScroll - currentScroll) * damping(reducedMotion ? 0.35 : 0.025);
    currentContact += (targetContact - currentContact) * damping(reducedMotion ? 0.35 : 0.06);
    if (Math.abs(targetContact - currentContact) < 0.0015) currentContact = targetContact;

    // smooth model rotation lerp (no pointer tilt when motion is reduced)
    mouseX += ((reducedMotion ? 0 : targetMouseX) - mouseX) * damping(0.05);
    mouseY += ((reducedMotion ? 0 : targetMouseY) - mouseY) * damping(0.05);

    // outer cursor ring lerps toward inner
    outerCursorX += (cursorX - outerCursorX) * damping(0.2);
    outerCursorY += (cursorY - outerCursorY) * damping(0.2);
    const cursorOuter = document.querySelector('.cursor-outer');
    if (cursorOuter) { cursorOuter.style.left = `${outerCursorX}px`; cursorOuter.style.top = `${outerCursorY}px`; }
    updateCursorLabel();

    // gentle interactive model tilt from mouse
    if (modelPivot) {
        // Contact chapter: the icon drifts up and to the left, away from the form,
        // turning slowly on itself and shrinking until it leaves the frame.
        const exit = smoothScrollRange(currentContact, 0, 0.85);
        modelPivot.rotation.y = mouseX * 0.25 + exit * 1.35;
        modelPivot.rotation.x = mouseY * 0.15 - exit * 0.35;
        modelPivot.rotation.z = exit * 0.55;
        modelPivot.position.set(-exit * 3.4, -0.3 + exit * 4.8, -exit * 1.2);
        modelPivot.scale.setScalar(1 - exit * 0.5);
    }

    // 2. sparks physics, accelerated/turbulent on fast scroll (frozen when motion is reduced)
    if (sparkParticles && !reducedMotion) {
        const positions = sparkParticles.geometry.attributes.position.array;
        const time = clock.getElapsedTime();
        const scrollVelocity = Math.abs(targetScroll - currentScroll);
        const speedMultiplier = 1.0 + scrollVelocity * 9.0;
        const turbulence = scrollVelocity * 0.8;

        for (let i = 0; i < sparkCount; i++) {
            const idx = i * 3;
            const data = sparkData[i];
            positions[idx]     += data.speedX * deltaTime * speedMultiplier;
            positions[idx + 1] += data.speedY * deltaTime * speedMultiplier;
            positions[idx + 2] += data.speedZ * deltaTime * speedMultiplier;

            const currentSway = data.swayRadius * (1.0 + turbulence * 4.0);
            positions[idx]     += Math.sin(time * data.swaySpeed + data.phase) * currentSway * deltaTime;
            positions[idx + 2] += Math.cos(time * data.swaySpeed + data.phase) * currentSway * deltaTime;

            // recycle when out of bounds
            if (positions[idx + 1] > 3.0 || Math.abs(positions[idx]) > 3.5 || Math.abs(positions[idx + 2]) > 3.5) {
                positions[idx + 1] = -2.5;
                positions[idx]     = (Math.random() - 0.5) * 3.0;
                positions[idx + 2] = (Math.random() - 0.5) * 3.0;
            }
        }
        sparkParticles.geometry.attributes.position.needsUpdate = true;
    }

    // Browser bars: the composition eases to the new visible height instead of jumping.
    if (Math.abs(sizes.view - sizes.visible) > 0.5) {
        sizes.view += (sizes.visible - sizes.view) * damping(reducedMotion ? 1 : 0.15);
        frameCamera();
    }

    // 3. camera orbits the model 360° driven by scroll
    const frame = cameraFrame(currentScroll);
    const phi = currentScroll * Math.PI * 2.0;
    const y = 0.35 + Math.sin(currentScroll * Math.PI) * 0.8;
    const targetPos = new THREE.Vector3(frame.radius * Math.sin(phi), y, frame.radius * Math.cos(phi));
    camera.position.lerp(targetPos, damping(reducedMotion ? 0.35 : 0.025));
    camera.lookAt(frame.lookAt);
    updateGlassCard();

    // background shader uniforms: the drizzle only breathes on its own when motion is allowed
    if (shaderUniforms) {
        if (!reducedMotion) shaderUniforms.uTime.value += deltaTime;
        shaderUniforms.uMouse.value.set(mouseX, -mouseY);
        shaderUniforms.uScroll.value = currentScroll;
        shaderUniforms.uContact.value = currentContact;   // crème turns to chocolat noir
        const velocity = reducedMotion ? 0 : Math.min(1, Math.abs(targetScroll - currentScroll) * 14);
        shaderUniforms.uVelocity.value += (velocity - shaderUniforms.uVelocity.value) * damping(0.06);
        updateRibbonPhases();
    }

    updateSugarDrops(shaderUniforms.uTime.value, getLogoSeparation(currentScroll));
    updateLogoPieces(currentScroll);
    updateSlides(currentScroll);
    updateHeader(currentScroll);
    updateContact();
    renderer.render(scene, camera);
}

// Header: active chapter link, chapter counter, progress hairline.
const headerState = { chapter: -1, progress: '' };
function updateHeader(scroll) {
    // Scroll cue: on the hero, until the visitor has scrolled a little.
    const atTop = window.scrollY < Math.max(40, stageMaxScroll() * 0.015);
    document.body.classList.toggle('show-scroll-hint',
        atTop && targetContact <= 0 && !document.body.classList.contains('is-loading'));
    const links = document.querySelectorAll('.header-nav .nav-link');
    const chapter = targetContact > 0.02 ? 4 : scroll < 0.20 ? 0 : scroll < 0.48 ? 1 : scroll < 0.76 ? 2 : 3;
    if (chapter !== headerState.chapter) {
        headerState.chapter = chapter;
        links.forEach((link, index) => link.classList.toggle('is-active', index === chapter));
        const counter = document.getElementById('brand-chapter');
        if (counter) counter.textContent = String(chapter + 1).padStart(2, '0');
    }
    const fill = document.getElementById('header-progress-fill');
    if (fill) {
        const total = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const progress = `${Math.min(100, (window.scrollY / total) * 100).toFixed(2)}%`;
        if (progress !== headerState.progress) { fill.style.width = progress; headerState.progress = progress; }
    }
}

// Chapter windows (smoothed scroll) and hold times so copy never flashes past on a
// fast scroll: a slide stays at least MIN_SHOW ms once shown and lingers LEAVE_HOLD ms
// after the scroll leaves its window, unless the next chapter takes over.
const SLIDE_WINDOWS = [[-0.10, 0.15], [0.26, 0.43], [0.54, 0.71], [0.82, 1.05]];
const SLIDE_MIN_SHOW = 1500, SLIDE_LEAVE_HOLD = 400;
const slideState = SLIDE_WINDOWS.map(() => ({ active: false, since: 0, left: 0 }));

function updateSlides(scroll) {
    const slides = [1, 2, 3, 4].map(i => document.getElementById(`slide-${i}`));
    for (let i = 1; i <= 4; i++) {
        const fill = document.getElementById(`dash-fill-${i}`);
        if (fill) {
            const start = (i - 1) * 0.25;
            const end = i * 0.25;
            let progress = (scroll - start) / (end - start);
            progress = Math.max(0, Math.min(1, progress));
            fill.style.height = `${progress * 100}%`;
        }
    }

    const now = performance.now();
    const loading = document.body.classList.contains('is-loading');
    const contactOpen = targetContact > 0.02;
    const inside = SLIDE_WINDOWS.map(([start, end]) => !loading && !contactOpen && scroll >= start && scroll <= end);
    const current = inside.indexOf(true);
    const actives = slideState.map((state, index) => {
        if (current === index) {
            if (!state.active) state.since = now;
            state.active = true;
            state.left = 0;
            return true;
        }
        if (state.active && current === -1 && !contactOpen && !loading) {
            if (!state.left) state.left = now;
            if (now - state.since < SLIDE_MIN_SHOW || now - state.left < SLIDE_LEAVE_HOLD) return true;
        }
        state.active = false;
        state.left = 0;
        return false;
    });
    slides.forEach((slide, index) => { if (slide) slide.classList.toggle('active', actives[index]); });
    playFigures(actives[3]);
}

// Slide 4 key figures count up each time the chapter appears.
let figuresPlaying = false, figuresShown = false;
function playFigures(show) {
    const values = document.querySelectorAll('.figure-value');
    if (!values.length || show === figuresShown) return;
    figuresShown = show;
    if (!show) { values.forEach(el => { el.textContent = (0).toFixed(Number(el.dataset.decimals || 0)); }); return; }
    const start = performance.now(), duration = 1400;
    const token = Symbol('figures');
    figuresPlaying = token;
    const frame = now => {
        if (figuresPlaying !== token) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 4);
        values.forEach(el => {
            const target = Number(el.dataset.count || 0), decimals = Number(el.dataset.decimals || 0);
            el.textContent = (target * eased).toFixed(decimals);
        });
        if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    const targetScrolls = [0.0, 0.34, 0.62, 0.94];
    navLinks.forEach((link, index) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetY = stageMaxScroll() * targetScrolls[index];
            window.scrollTo({ top: targetY, behavior: reducedMotion ? 'auto' : 'smooth' });
        });
    });
    document.querySelectorAll('.brand, .footer-top').forEach(link => {
        link.addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' }); });
    });
    const hint = document.querySelector('.scroll-hint');
    if (hint) {
        hint.addEventListener('click', () => {
            window.scrollTo({ top: stageMaxScroll() * targetScrolls[1], behavior: reducedMotion ? 'auto' : 'smooth' });
        });
    }
    document.querySelectorAll('.contact-btn, .cta-btn').forEach(button => {
        if (!contactSection) return;
        button.addEventListener('click', (e) => {
            e.preventDefault();
            window.scrollTo({ top: contactSection.offsetTop, behavior: reducedMotion ? 'auto' : 'smooth' });
        });
    });
}

function updateContact() {
    if (!contactSection) return;
    document.body.classList.toggle('contact-open', targetContact > 0.02);
    // Chrome turns crème only once the stage behind it has gone dark.
    document.body.classList.toggle('contact-dark', currentContact > 0.5);
    contactSection.classList.toggle('is-visible', currentContact > 0.6);
}

// The form opens the visitor's mail client with a ready-to-send message.
function buildMailto(form) {
    const data = new FormData(form);
    const field = name => String(data.get(name) || '').trim();
    const name = field('name'), email = field('email'), company = field('company'), project = field('project');
    const to = form.dataset.email;
    const subject = `Projet GTM — ${name}${company ? ` (${company})` : ''}`;
    const body = [`Nom : ${name}`, `E-mail : ${email}`, company ? `Entreprise : ${company}` : null, '', project]
        .filter(line => line !== null).join('\n');
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function setupContactForm() {
    const form = document.querySelector('#contact-form');
    if (!form) return;
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        window.location.href = buildMailto(form);
    });
}

// QA hook: jump the smoothed scroll straight to a normalised position (0..1).
window.__glassSite = {
    snap(value) {
        window.scrollTo(0, stageMaxScroll() * value);
        currentScroll = value;
        currentContact = targetContact = 0;
        // Let the camera settle immediately as well.
        const phi = value * Math.PI * 2.0;
        const { radius, lookAt } = cameraFrame(value);
        if (camera) {
            camera.position.set(radius * Math.sin(phi), 0.35 + Math.sin(value * Math.PI) * 0.8, radius * Math.cos(phi));
            camera.lookAt(lookAt);
        }
        if (logoPieces.length) updateLogoPieces(value);
    },
    snapContact(value) {
        window.scrollTo(0, stageMaxScroll() + window.innerHeight * value);
        currentScroll = 1;
        currentContact = targetContact = value;
        this.snap(1);
        window.scrollTo(0, stageMaxScroll() + window.innerHeight * value);
        currentContact = targetContact = value;
    },
    mailto() { const form = document.querySelector('#contact-form'); return form ? buildMailto(form) : null; },
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
    get card() { return glassCard; },
    // Average GPU+CPU time of one render, forced to completion: compare before/after tuning.
    bench(frames = 40) {
        const gl = renderer.getContext(), pixel = new Uint8Array(4);
        const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        updateLogoPieces(currentScroll);
        renderer.render(scene, camera); sync();
        const start = performance.now();
        for (let i = 0; i < frames; i++) renderer.render(scene, camera);
        sync();
        return { ms: +((performance.now() - start) / frames).toFixed(2), pixelRatio: renderer.getPixelRatio(),
                 buffer: renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() };
    },
    // GPU time per render from timer queries: independent of vsync and tab throttling.
    async gpuBench(frames = 20) {
        const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        if (!ext) return 'no timer query';
        updateLogoPieces(currentScroll);
        updateGlassCard();
        renderer.render(scene, camera);
        const queries = [];
        for (let i = 0; i < frames; i++) {
            const query = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
            renderer.render(scene, camera);
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            queries.push(query);
        }
        const times = [];
        for (const query of queries) {
            while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) await new Promise(r => setTimeout(r, 5));
            if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(query);
        }
        times.sort((x, y) => x - y);
        return { gpuMs: +times[Math.floor(times.length / 2)].toFixed(2), pixelRatio: renderer.getPixelRatio() };
    },
    // CPU time of one fragment update at a scroll position, geometry rebuilds included.
    logoUpdateMs(value) {
        const start = performance.now();
        updateLogoPieces(value);
        return +(performance.now() - start).toFixed(2);
    },
    get scroll() { return currentScroll; },
    get contact() { return currentContact; },
    get pieces() { return logoPieces.map(p => ({ name: p.name, points: p.correspondence.length })); }
};

function init() {
    splitTitlesIntoLines();
    fitTitles();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(BRAND.creme);
    scene.fog = new THREE.FogExp2(BRAND.creme, 0.006);

    camera = new THREE.PerspectiveCamera(50, sizes.width / sizes.height, 0.1, 100);
    camera.position.set(0, 0.2, 3.0);
    scene.add(camera);

    createBackgroundShader();   // adds the drizzle plane as a child of the camera

    renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance"
    });
    // The canvas's displayed size is CSS (100% × 100lvh); only its pixels are set here.
    renderer.setDrawingBufferSize(sizes.width, sizes.height, pixelRatio);

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const ambientLight = new THREE.AmbientLight(BRAND.reflet, 0.15);
    scene.add(ambientLight);

    // Key light: the pastry chef's lamp, warm and straight from above
    const keyLight = new THREE.SpotLight(BRAND.reflet, 14.0);
    keyLight.position.set(1.2, 7, 2.5);
    keyLight.angle = Math.PI / 4;
    keyLight.penumbra = 0.9;
    scene.add(keyLight);

    // Rim light: caramel glow from behind-left, defines the silhouette
    const rimLight = new THREE.DirectionalLight(BRAND.coeur, 4.0);
    rimLight.position.set(-5, 3, -4);
    scene.add(rimLight);

    // Fill light: faint crème from below-front
    const fillLight = new THREE.DirectionalLight(BRAND.creme, 0.6);
    fillLight.position.set(-2, -4, 2);
    scene.add(fillLight);

    createSparks();
    createGlassLogo();
    if (GLASS_CARD) createGlassCard();
    onWindowResize();
    // Compile the card's shader now rather than when the visitor reaches the form.
    if (glassCard) {
        glassCard.visible = true;
        renderer.compile(scene, camera);
        glassCard.visible = false;
    }
    // Commit the hidden letter state before the first reveal.
    document.querySelector('.slide-title').getBoundingClientRect();
    animate();
    setupNavigation();
    setupContactForm();
    // First frame rendered, shaders compiled: release the preloader once fonts are in.
    const release = () => { fitTitles(); if (window.__glassLoader) window.__glassLoader.done(); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(release, release); else release();
}
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
