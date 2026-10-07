/* =========================================================
   NOCATERATE — intro → transition → portfolio
   ========================================================= */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const intro = $("#intro");
  const trans = $("#transition");
  const video = $("#transition-video");
  const bgm = $("#bgm");
  const site = $("#site");
  const stage = $(".stage");
  const cam = $(".stage__cam");
  const pan = $(".stage__pan");

  const soundBtn = $(".hud__sound");
  const root = document.documentElement;

  const MUSIC_VOLUME = 0.6;
  const MOON_DISTANCE = 384400; // km, drives the HUD altitude readout
  const DIVE_START_ALT = 68114;  // from this readout the camera dives down onto the moon surface
  // The song crossfades in under the transition sound so the lyric
  // "So get away, another way to feel..." ("S" at 30.24s) lands right as that sound ends.
  // After the track finishes, the loop restarts from 0:00 as normal.
  const SONG_HIT = 30.24;
  const CROSSFADE = 0.6;                   // seconds the two sounds overlap
  const SONG_START = SONG_HIT - CROSSFADE; // start a little earlier in the track, under the clip
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let started = false;
  let revealed = false;
  let musicOk = true;

  gsap.registerPlugin(ScrollTrigger);

  // Split hero title into characters for the shatter effect
  const heroTitle = $(".hero__title");
  const titleFx = createTitleFx(heroTitle); // pixel/glitch dissolve, driven by the hero scroll

  /* ---------------------------------------------------------
     0. PRELOAD — fill the intro bar as assets become ready,
        then build the whole site quietly behind the intro
     --------------------------------------------------------- */
  (function preload() {
    const pctEl = $(".boot-pct");
    const bar = $(".intro__bar span");
    const bgImg = $(".stage__img--base");
    const whenMedia = (el) => new Promise((r) => {
      if (el.readyState >= 3) return r();
      el.addEventListener("canplaythrough", r, { once: true });
      el.addEventListener("error", r, { once: true });
    });
    const jobs = [
      new Promise((r) => (bgImg.complete ? r() : (bgImg.onload = bgImg.onerror = r))).then(() => bgImg.decode().catch(() => {})),
      whenMedia(bgm),
      whenMedia(video),
    ];
    let done = 0;
    let isReady = false;
    const shown = { v: 0 };
    const render = () => {
      bar.style.transform = `scaleX(${shown.v / 100})`;
      pctEl.textContent = String(Math.round(shown.v)).padStart(3, "0") + "%";
    };
    const ready = () => {
      if (isReady) return;
      isReady = true;
      if (!started) prepareSite();
      gsap.to(shown, { v: 100, duration: 0.4, onUpdate: render, onComplete: () => intro.classList.add("is-ready") });
    };
    jobs.forEach((j) => j.then(() => {
      done++;
      gsap.to(shown, { v: (done / jobs.length) * 100, duration: 0.6, onUpdate: render });
      if (done === jobs.length) setTimeout(ready, 900);
    }));
    setTimeout(ready, 8000); // never keep anyone waiting forever
  })();

  /* ---------------------------------------------------------
     1. INTRO → click
     --------------------------------------------------------- */
  function start() {
    if (started) return;
    started = true;
    prepareSite(); // no-op if it already ran during the intro

    // Unlock audio inside the click gesture so it can play after the video
    setupAnalyser();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    bgm.volume = 0;
    bgm.play().then(() => {
      if (!musicStarted) { bgm.pause(); bgm.currentTime = SONG_START; }
    }).catch(() => { musicOk = false; });

    trans.classList.add("is-active");
    playTransition();

    // Intro melts away over the already-playing clip
    intro.classList.add("is-leaving");
    gsap.timeline({ onComplete: () => intro.remove() })
      .to(".intro__title", { scale: 1.25, opacity: 0, duration: 0.6, ease: "power2.in" }, 0)
      .to([".intro__bar", ".intro__prompt", ".intro__corner"], { opacity: 0, duration: 0.3, ease: "power1.out" }, 0)
      .to(intro, { opacity: 0, duration: 0.7, ease: "power2.inOut" }, 0.05);
  }

  intro.addEventListener("click", start);
  document.addEventListener("keydown", (e) => {
    if (!started && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); start(); }
  });

  /* ---------------------------------------------------------
     2. TRANSITION (video, or built-in glitch fallback)
     --------------------------------------------------------- */
  const BRIDGE_START = 1.3; // where the rendered bridge begins inside transition-full.mp4 (the clip's audio stops here)
  const PLAY_LATENCY = 0.04; // fire a touch early to absorb play() latency
  const HANDOFF_LEAD = 0.1;  // the bridge's last frames are an exact still of the site
  let fallbackRunning = false;
  let musicCued = false;

  function playTransition() {
    let playing = false;
    const timer = setTimeout(() => { if (!playing) runFallback(); }, 3000);

    // Watch the playhead every frame: cue the music as the bridge starts,
    // hand over to the live page on the bridge's final (matching) frame
    const watch = () => {
      if (!video.duration) return;
      const t = video.currentTime;
      if (!musicCued && t >= BRIDGE_START - CROSSFADE - PLAY_LATENCY) {
        musicCued = true;
        startMusic(CROSSFADE, video); // song swells in as the clip's sound fades out

      }
      if (t >= video.duration - HANDOFF_LEAD) {
        gsap.ticker.remove(watch);
        handoff();
      }
    };

    video.addEventListener("error", () => { clearTimeout(timer); runFallback(); }, { once: true });
    video.addEventListener("playing", () => { playing = true; clearTimeout(timer); gsap.ticker.add(watch); }, { once: true });
    video.addEventListener("ended", () => { gsap.ticker.remove(watch); handoff(); }, { once: true });

    video.play().catch(() => {
      video.muted = true; // retry silently if audio was refused
      video.play().catch(() => { clearTimeout(timer); runFallback(); });
    });

    trans.addEventListener("click", () => {
      if (fallbackRunning) return;
      gsap.ticker.remove(watch);
      skipOutro();
    });
  }

  // The bridge ends on the site's exact opening frame, so the live page just fades in on top
  function handoff() {
    if (revealed) return;
    revealSite({ settle: false });
    gsap.to(trans, {
      opacity: 0, duration: 0.45, ease: "power1.out",
      onComplete: () => { video.pause(); trans.remove(); },
    });
  }

  // Click-to-skip: dissolve from wherever the clip happens to be
  function skipOutro() {
    if (revealed) return;
    revealSite();
    gsap.to(video, { volume: 0, duration: 0.5, ease: "sine.out" });
    gsap.to(trans, {
      opacity: 0, duration: 0.8, ease: "sine.inOut",
      onComplete: () => { video.pause(); trans.remove(); },
    });
  }

  function runFallback() {
    if (fallbackRunning || revealed) return;
    fallbackRunning = true;
    trans.classList.add("is-fallback");

    const holder = $(".slices", trans);
    const colors = ["#fcee0a", "#00f0ff", "#ff2a6d", "#fcee0a", "#0a0a0a"];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const s = document.createElement("i");
      s.style.top = `${(100 / count) * i}%`;
      s.style.height = `${100 / count + 0.5}%`;
      s.style.background = colors[i % colors.length];
      holder.appendChild(s);
    }
    const slices = $$("i", holder);
    const text = $(".transition__text", trans);

    gsap.timeline()
      .to(slices, { x: "0%", duration: 0.55, ease: "expo.out", stagger: { each: 0.03, from: "random" } })
      .to(slices, { background: "#fcee0a", duration: 0.01 })
      .fromTo(text, { opacity: 0, scale: 1.4 }, { opacity: 1, scale: 1, duration: 0.35, ease: "expo.out" })
      .to(text, { x: -8, duration: 0.05, repeat: 5, yoyo: true, ease: "none" })
      .to({}, { duration: 0.45 })
      .add(() => revealSite())
      .to(text, { opacity: 0, duration: 0.15 })
      .to(slices, { x: "101%", duration: 0.6, ease: "expo.in", stagger: { each: 0.025, from: "random" } }, "<")
      .add(() => trans.remove());
  }

  /* ---------------------------------------------------------
     3. SITE — prepared early (hidden behind the intro),
        revealed with one light, GPU-only move
     --------------------------------------------------------- */
  let prepared = false;
  let entrance = null;

  function prepareSite() {
    if (prepared) return;
    prepared = true;

    site.classList.add("is-on");
    initSmoothScroll();
    initScroll();
    initDust();

    // Built now (paused) so its start state is already applied before the reveal
    entrance = gsap.timeline({ paused: true })
      .from(heroTitle, { opacity: 0, scale: 1.12, y: 24, duration: 1.8, ease: "expo.out", clearProps: "transform" }, 0.35)
      .from(".hero__kicker", { opacity: 0, y: 20, duration: 1, ease: "expo.out" }, 0.55)
      .from([".hero__sub", ".hero__scroll"], { opacity: 0, y: 20, duration: 1, stagger: 0.12, ease: "expo.out" }, 0.8)
      .from(".hud > *", { opacity: 0, y: -10, duration: 0.8, stagger: 0.06, ease: "power2.out" }, 0.9);
  }

  function revealSite({ settle = true } = {}) {
    if (revealed) return;
    revealed = true;
    prepareSite();

    // The bridge already lands on the resting frame; other paths get a gentle settle
    if (settle) gsap.fromTo(stage, { scale: 1.14 }, { scale: 1, duration: 3.2, ease: "power3.out", clearProps: "transform" });

    root.classList.remove("is-locked");
    if (lenis) { lenis.scrollTo(0, { immediate: true, force: true }); lenis.start(); }
    else window.scrollTo(0, 0);

    startMusic();
    entrance.play();
    dispatchEvent(new Event("nc:revealed"));
    initCursor();
    initTilt();
  }

  /* ---------------------------------------------------------
     Music + audio-reactive glow
     --------------------------------------------------------- */
  let analyser = null;
  let audioCtx = null;
  let freq = null;
  let beatOn = false;

  function setupAnalyser() {
    // Web Audio can't read local file:// media, so only hook it up over http(s)
    if (!location.protocol.startsWith("http")) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(bgm);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      analyser.connect(audioCtx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      analyser = null;
    }
  }

  let musicStarted = false;
  // fade: seconds to reach full volume; partner: a media element to fade out at the same time
  function startMusic(fade = 0.4, partner = null) {
    if (musicStarted) return;
    musicStarted = true;
    if (!musicOk) return setNoTrack();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    if (Math.abs(bgm.currentTime - SONG_START) > 0.05) bgm.currentTime = SONG_START;
    bgm.volume = 0;
    // equal-power crossfade keeps the combined loudness even (no dip in the middle)
    const x = { p: 0 };
    const startVol = partner ? partner.volume : 0;
    gsap.to(x, {
      p: 1, duration: fade, ease: "none",
      onUpdate: () => {
        bgm.volume = MUSIC_VOLUME * Math.sin(x.p * Math.PI / 2);
        if (partner) partner.volume = startVol * Math.cos(x.p * Math.PI / 2);
      },
    });
    bgm.play()
      .then(() => { if (analyser) startBeat(); })
      .catch(setNoTrack);
  }

  function startBeat() {
    if (beatOn) return;
    beatOn = true;
    const bars = $$(".eq i");
    $(".eq").classList.add("is-live");
    const beatEls = $$(".stage__earthglow, .hero__title, .hud__brand, .foot__big");
    let beat = 0, lastBeat = -1;
    gsap.ticker.add(() => {
      analyser.getByteFrequencyData(freq);
      let bass = 0;
      for (let i = 1; i < 8; i++) bass += freq[i];
      bass = bass / (7 * 255);
      const target = Math.max(0, (bass - 0.45) / 0.55); // ignore the constant floor
      beat += (target - beat) * (target > beat ? 0.5 : 0.08);
      if (Math.abs(beat - lastBeat) > 0.004) {
        lastBeat = beat;
        const v = beat.toFixed(3);
        beatEls.forEach((el) => el.style.setProperty("--beat", v));
      }
      bars.forEach((b, i) => { b.style.height = `${15 + (freq[2 + i * 9] / 255) * 85}%`; });
    });
  }

  function setNoTrack() {
    soundBtn.classList.add("is-muted");
    $(".hud__sound-label").textContent = "NO TRACK";
  }

  soundBtn.addEventListener("click", () => {
    const label = $(".hud__sound-label");
    if (bgm.paused) {
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      bgm.play().then(() => {
        gsap.to(bgm, { volume: MUSIC_VOLUME, duration: 0.6 });
        soundBtn.classList.remove("is-muted");
        label.textContent = "SOUND ON";
        if (analyser) startBeat();
      }).catch(setNoTrack);
    } else {
      gsap.to(bgm, { volume: 0, duration: 0.4, onComplete: () => bgm.pause() });
      soundBtn.classList.add("is-muted");
      label.textContent = "SOUND OFF";
    }
  });

  /* ---------------------------------------------------------
     Smooth scroll (Lenis, optional)
     --------------------------------------------------------- */
  let lenis = null;

  // Scroll faster through the hero: from the top until the altitude readout hits 077812,
  // then ease back to normal speed for the rest of the page
  const HERO_BOOST = 2;
  const BOOST_END_ALT = 77812;
  function scrollBoostAt(y) {
    const end = ScrollTrigger.maxScroll(window) * (1 - Math.cbrt(BOOST_END_ALT / MOON_DISTANCE));
    const fade = innerHeight * 0.35; // taper instead of a sudden change in speed
    const t = gsap.utils.clamp(0, 1, (y - (end - fade)) / fade);
    return 1 + (HERO_BOOST - 1) * (1 - t * t * (3 - 2 * t));
  }

  function initSmoothScroll() {
    if (window.Lenis && !reduceMotion) {
      lenis = new Lenis({
        lerp: 0.07, wheelMultiplier: 0.9, smoothWheel: true,
        virtualScroll: (e) => { e.deltaY *= scrollBoostAt(lenis.targetScroll); return true; },
      });
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add((t) => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
      if (!revealed) lenis.stop();
    }
    $$('a[href^="#"]').forEach((a) => {
      a.addEventListener("click", (e) => {
        const target = $(a.getAttribute("href"));
        if (!target) return;
        e.preventDefault();
        if (lenis) lenis.scrollTo(target, { duration: 2, easing: (t) => 1 - Math.pow(1 - t, 4) });
        else target.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  /* ---------------------------------------------------------
     CAMERA GEOMETRY — the wallpaper is taller than the screen,
     so the camera can glide from the earth down to the craters
     --------------------------------------------------------- */
  const baseImg = $(".stage__img--base");
  const imgRatio = () => (baseImg.naturalWidth ? baseImg.naturalHeight / baseImg.naturalWidth : 16 / 9);

  function geo() {
    const vw = innerWidth, vh = innerHeight;
    const W = Math.max(vw, vh * 0.75);
    const H = W * imgRatio();
    const clamp = gsap.utils.clamp(vh - H, 0);
    return {
      W, H,
      yStart: clamp(vh * 0.5 - H * 0.47), // earth + David & Lucy centered
      yMid: clamp(vh * 0.62 - H * 0.6),   // dipping past their backs
      yEnd: vh - H,                       // moon surface / craters
    };
  }

  function layoutPan() {
    const g = geo();
    gsap.set(pan, { width: g.W, height: g.H, xPercent: -50 });
  }

  /* ---------------------------------------------------------
     HERO TITLE — pixel / glitch dissolve, scrubbed by scroll.
     The real text stays in the DOM (invisible) for layout + a11y;
     a canvas on top draws it and breaks it apart as fx.p goes 0 → 1.
     --------------------------------------------------------- */
  function createTitleFx(h2) {
    const label = h2.textContent.trim();
    h2.innerHTML = `<span class="hero__title-text">${label}</span><canvas class="hero__title-fx" aria-hidden="true"></canvas>`;
    const cv = h2.querySelector("canvas");
    const ctx = cv.getContext("2d");
    const work = document.createElement("canvas"); // pixelated + masked text
    const wctx = work.getContext("2d");
    const tint = document.createElement("canvas"); // red / cyan copies
    const tctx = tint.getContext("2d");
    const small = document.createElement("canvas"); // mosaic downsample
    const sctx = small.getContext("2d");
    const mask = document.createElement("canvas"); // one pixel per dissolve cell
    const mctx = mask.getContext("2d");
    const text = document.createElement("canvas"); // crisp yellow text
    const xctx = text.getContext("2d");

    const fx = { p: 0 };
    const PAD = 80;   // room for glow + sideways glitches
    const CELL = 9;   // dissolve cell size (css px)
    let W = 0, H = 0, dpr = 1, cols = 0, rows = 0, rnd = null, maskData = null, ready = false;

    function layout() {
      const r = h2.getBoundingClientRect();
      const cs = getComputedStyle(h2);
      dpr = Math.min(devicePixelRatio || 1, 2);
      W = Math.ceil(h2.offsetWidth + PAD * 2);
      H = Math.ceil(h2.offsetHeight + PAD * 2);
      for (const c of [cv, work, tint, text]) { c.width = W * dpr; c.height = H * dpr; }
      Object.assign(cv.style, { width: W + "px", height: H + "px", left: -PAD + "px", top: -PAD + "px" });

      // crisp text, same font as the DOM title
      xctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      xctx.clearRect(0, 0, W, H);
      xctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      xctx.textAlign = "center";
      xctx.textBaseline = "middle";
      xctx.fillStyle = cs.color;
      const m = xctx.measureText(label);
      const mid = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
      xctx.fillText(label, W / 2, H / 2 + mid);

      // dissolve order: fine random noise mixed with coarse chunks → blocky clusters
      cols = Math.ceil(W / CELL); rows = Math.ceil(H / CELL);
      mask.width = cols; mask.height = rows;
      maskData = mctx.createImageData(cols, rows);
      const coarse = {};
      rnd = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const k = `${(x / 5) | 0},${(y / 3) | 0}`;
        if (coarse[k] === undefined) coarse[k] = Math.random();
        rnd[y * cols + x] = 0.55 * Math.random() + 0.45 * coarse[k];
      }
      ready = r.width > 0;
    }

    const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

    function render() {
      if (!ready) return;
      const p = fx.p;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (p >= 0.999) return;

      const beat = parseFloat(h2.style.getPropertyValue("--beat")) || 0;
      const g = smoothstep(0, 0.12, p); // glitch intensity ramps in

      // 1) mosaic: blocks grow from crisp to chunky
      const block = 1 + 22 * Math.pow(p, 1.5);
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.globalCompositeOperation = "source-over";
      wctx.clearRect(0, 0, work.width, work.height);
      if (block < 1.4) {
        wctx.drawImage(text, 0, 0);
      } else {
        small.width = Math.max(1, Math.round(W / block));
        small.height = Math.max(1, Math.round(H / block));
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(text, 0, 0, small.width, small.height);
        wctx.imageSmoothingEnabled = false;
        wctx.drawImage(small, 0, 0, work.width, work.height);
      }

      // 2) dissolve: cells drop out in clusters, the edge flickers
      if (p > 0.02) {
        const thr = p * 1.2 - 0.12;
        const d = maskData.data;
        for (let i = 0; i < rnd.length; i++) {
          const v = rnd[i];
          const alive = v > thr + 0.07 || (v > thr && Math.random() > 0.5);
          d[i * 4 + 3] = alive ? 255 : 0;
        }
        mctx.putImageData(maskData, 0, 0);
        wctx.globalCompositeOperation = "destination-in";
        wctx.imageSmoothingEnabled = false;
        wctx.drawImage(mask, 0, 0, work.width, work.height);
        wctx.globalCompositeOperation = "source-over";
      }

      // 3) draw in horizontal bands; some bands jump sideways, with red/cyan split
      const split = (2 + 10 * p) * g * dpr;
      const glow = (20 + beat * 40) * (1 - p) * dpr;
      const bands = [];
      if (g > 0) {
        let y = 0;
        while (y < H) {
          const bh = 3 + Math.random() * 16;
          const jump = Math.random() < 0.12 + 0.45 * p ? (Math.random() - 0.5) * 90 * p * g : 0;
          bands.push([y, bh, jump]);
          y += bh;
        }
      } else {
        bands.push([0, H, 0]);
      }

      const drawBands = (src, dx, alpha, composite) => {
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = composite;
        for (const [y, bh, jump] of bands) {
          const sy = y * dpr, sh = Math.min(bh, H - y) * dpr;
          ctx.drawImage(src, 0, sy, work.width, sh, dx + jump * dpr, sy, work.width, sh);
        }
      };

      if (split > 0.5) {
        for (const [color, dx] of [["#ff2a6d", split], ["#00f0ff", -split]]) {
          tctx.globalCompositeOperation = "source-over";
          tctx.clearRect(0, 0, tint.width, tint.height);
          tctx.drawImage(work, 0, 0);
          tctx.globalCompositeOperation = "source-in";
          tctx.fillStyle = color;
          tctx.fillRect(0, 0, tint.width, tint.height);
          drawBands(tint, dx, 0.75, "lighter");
        }
      }

      ctx.shadowColor = `rgba(252,238,10,${0.3 + beat * 0.4})`;
      ctx.shadowBlur = glow;
      drawBands(work, 0, 1, "source-over");
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // Redraw every frame while the title is on screen (the edge flicker lives even when idle)
    let lastP = -1, lastBeat = -1;
    gsap.ticker.add(() => {
      if (scrollY > innerHeight * 3) return;
      const beat = h2.style.getPropertyValue("--beat");
      const animating = fx.p > 0.001 && fx.p < 0.999;
      if (animating || fx.p !== lastP || beat !== lastBeat) render();
      lastP = fx.p; lastBeat = beat;
    });

    const relayout = () => { layout(); render(); };
    addEventListener("resize", relayout);
    (document.fonts ? document.fonts.load(`900 100px Orbitron`).then(() => document.fonts.ready) : Promise.resolve())
      .then(relayout);
    return fx;
  }

  /* ---------------------------------------------------------
     SCROLL MOTION
     --------------------------------------------------------- */
  function initScroll() {
    const dim = $(".stage__dim");

    layoutPan();
    gsap.set(pan, { y: geo().yStart });
    ScrollTrigger.addEventListener("refreshInit", layoutPan);
    if (!baseImg.complete) baseImg.addEventListener("load", () => ScrollTrigger.refresh());

    // --- HERO: camera pushes in on David & Lucy, title pixel-dissolves ---
    gsap.timeline({
      scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom bottom", scrub: 1.2, invalidateOnRefresh: true },
      defaults: { ease: "none" },
    })
      .fromTo(cam, { scale: 1, rotate: 0 }, { scale: 1.32, rotate: -1.5, duration: 0.7, ease: "power1.inOut" }, 0)
      .fromTo(pan, { y: () => geo().yStart }, { y: () => geo().yMid, duration: 1, ease: "power1.in" }, 0)
      .to([".hero__kicker", ".hero__sub", ".hero__scroll"], {
        opacity: 0, y: -60, filter: "blur(6px)", duration: 0.22, stagger: 0.03,
      }, 0)
      .to(titleFx, { p: 1, duration: 0.55, ease: "none" }, 0.03)
      .fromTo(".hero__quote",
        { opacity: 0, letterSpacing: "0.6em", y: 30, filter: "blur(8px)" },
        { opacity: 1, letterSpacing: "0.12em", y: 0, filter: "blur(0px)", duration: 0.2 }, 0.45)
      .to(".hero__quote", { opacity: 0, y: -40, filter: "blur(8px)", duration: 0.15 }, 0.85)
      .to(dim, { opacity: 0.15, duration: 0.4 }, 0.6);

    // Scroll position where the HUD readout shows a given altitude
    const altToScroll = (alt) => ScrollTrigger.maxScroll(window) * (1 - Math.cbrt(alt / MOON_DISTANCE));

    // --- DRIFT: keep the camera alive between the hero and the dive ---
    gsap.fromTo(cam, { scale: 1.32, rotate: -1.5 }, {
      scale: 1.38, rotate: -2.5, ease: "none", immediateRender: false,
      scrollTrigger: {
        trigger: ".hero", start: "bottom bottom",
        end: () => altToScroll(DIVE_START_ALT),
        scrub: 1.2, invalidateOnRefresh: true,
      },
    });

    // --- DIVE: from 068114 km the camera plunges down the wallpaper onto the moon surface ---
    gsap.timeline({
      scrollTrigger: {
        start: () => altToScroll(DIVE_START_ALT),
        endTrigger: "#about", end: "top bottom",
        scrub: 1.4, invalidateOnRefresh: true,
      },
      defaults: { ease: "none" },
    })
      .fromTo(pan, { y: () => geo().yMid }, { y: () => geo().yEnd, duration: 1, ease: "power2.inOut", immediateRender: false }, 0)
      .fromTo(cam, { scale: 1.38, rotate: -2.5 }, { scale: 1.08, rotate: 0.5, duration: 1, ease: "power1.inOut", immediateRender: false }, 0)
      .fromTo(cam, { rotateX: 0 }, { rotateX: 9, transformPerspective: 1400, duration: 0.4, ease: "sine.inOut", yoyo: true, repeat: 1 }, 0.1);

    // --- PORTAL: plunge into the surface, then the section video switches on like a CRT ---
    const vid = $(".stage__video");
    const vidEl = $(".stage__video-el");
    const flashLine = $(".stage__flash");
    const dust = $(".stage__dust");
    const markNoVideo = () => vid.classList.add("no-video");
    vidEl.addEventListener("error", markNoVideo);
    if (vidEl.error || vidEl.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) markNoVideo();

    gsap.timeline({
      scrollTrigger: { trigger: "#about", start: "top bottom", end: "top 25%", scrub: 1, invalidateOnRefresh: true },
      defaults: { ease: "none" },
    })
      .fromTo(cam, { scale: 1.08 }, { scale: 1.9, duration: 1, ease: "power2.in", immediateRender: false }, 0)
      .to(dim, { opacity: 0.9, duration: 0.55, ease: "power1.in" }, 0.1)
      .to(dust, { opacity: 0, duration: 0.4 }, 0.35)
      .fromTo(flashLine, { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.2, ease: "power2.out", immediateRender: false }, 0.45)
      .fromTo(vid, { autoAlpha: 0, clipPath: "inset(50% 0% 50% 0%)" },
        { autoAlpha: 1, clipPath: "inset(0% 0% 0% 0%)", duration: 0.4, ease: "power3.inOut", immediateRender: false }, 0.6)
      .fromTo(vidEl, { scale: 1.2 }, { scale: 1, duration: 0.4, ease: "power2.out", immediateRender: false }, 0.6)
      .to(flashLine, { opacity: 0, duration: 0.15 }, 0.78)
      // fully covered: drop the clip mask and stop compositing the moon underneath
      .set(vid, { clipPath: "none" }, 1)
      .set([cam, dust], { autoAlpha: 0 }, 1);

    // Start buffering the section video once the intro assets are done, and at the latest when the dive begins
    const warmVideo = () => { if (vidEl.preload !== "auto") vidEl.preload = "auto"; };
    ScrollTrigger.create({ start: () => altToScroll(DIVE_START_ALT), onEnter: warmVideo });
    if (revealed) setTimeout(warmVideo, 4000); else addEventListener("nc:revealed", () => setTimeout(warmVideo, 4000), { once: true });

    // Only decode the section video while it can be seen
    ScrollTrigger.create({
      trigger: "#about", start: "top 60%", end: () => ScrollTrigger.maxScroll(window) + 1,
      onToggle: (self) => {
        if (vid.classList.contains("no-video")) return;
        if (self.isActive) vidEl.play().catch(() => {}); else vidEl.pause();
      },
    });

    // --- MARQUEE: two bands sliding opposite ways ---
    gsap.fromTo(".marquee__row--a .marquee__track", { xPercent: 0 }, {
      xPercent: -50, ease: "none",
      scrollTrigger: { trigger: ".marquee", start: "top bottom", end: "bottom top", scrub: 0.6 },
    });
    gsap.fromTo(".marquee__row--b .marquee__track", { xPercent: -50 }, {
      xPercent: 0, ease: "none",
      scrollTrigger: { trigger: ".marquee", start: "top bottom", end: "bottom top", scrub: 0.6 },
    });

    // --- Per-section entrance ---
    const navLinks = $$(".hud__nav a");
    $$(".panel").forEach((panel) => {
      const wipe = $(".wipe", panel);
      const num = $(".panel__num", panel);
      const kicker = $(".panel__kicker", panel);
      const title = $(".panel__title", panel);

      gsap.fromTo(wipe, { scaleX: 0 }, {
        scaleX: 1, ease: "none",
        scrollTrigger: { trigger: panel, start: "top 95%", end: "top 40%", scrub: true },
      });

      gsap.timeline({ scrollTrigger: { trigger: panel, start: "top 70%" } })
        .from(num, { xPercent: -120, opacity: 0, skewX: 30, duration: 1.1, ease: "expo.out" })
        .from(kicker, { opacity: 0, x: -20, duration: 0.5 }, 0.15)
        .add(() => scramble(title), 0.1);

      ScrollTrigger.create({
        trigger: panel, start: "top center", end: "bottom center",
        onToggle: (self) => {
          const link = navLinks.find((a) => a.getAttribute("href") === `#${panel.id}`);
          if (link) link.classList.toggle("is-active", self.isActive);
        },
      });
    });

    // Boxes materialize with a CRT/glitch flicker and only a small, short rise
    $$("[data-reveal]").forEach((el) => {
      gsap.set(el, { autoAlpha: 0 });
      ScrollTrigger.create({
        trigger: el, start: "top 88%", once: true,
        onEnter: () => {
          gsap.set(el, { autoAlpha: 1 });
          el.classList.add("is-in", "glitch-in");
          setTimeout(() => el.classList.remove("glitch-in"), 800);
          gsap.fromTo(el, { y: 32 }, {
            y: 0, duration: 0.9, ease: "expo.out",
            onComplete: () => el.classList.add("is-done"),
          });
        },
      });
    });
    initBoxGlitch();

    gsap.from(".foot__big", {
      opacity: 0, y: 60, letterSpacing: "0.4em", duration: 1.6, ease: "expo.out",
      scrollTrigger: { trigger: ".foot", start: "top 90%" },
    });

    // --- HUD progress + "altitude" readout ---
    const bar = $(".hud__progress span");
    const pct = $(".hud__pct");
    const alt = $(".hud__alt-val");
    ScrollTrigger.create({
      start: 0, end: "max",
      onUpdate: (self) => {
        const p = self.progress;
        gsap.set(bar, { scaleX: p });
        pct.textContent = String(Math.round(p * 100)).padStart(3, "0");
        alt.textContent = String(Math.round(MOON_DISTANCE * Math.pow(1 - p, 3))).padStart(6, "0");
      },
    });

    // --- Velocity glitch: RGB split on the moon while scrolling fast ---
    const rImg = $(".stage__img--r");
    const cImg = $(".stage__img--c");
    const setRy = gsap.quickSetter(rImg, "y", "px");
    const setCy = gsap.quickSetter(cImg, "y", "px");
    const setRx = gsap.quickSetter(rImg, "x", "px");
    const setCx = gsap.quickSetter(cImg, "x", "px");
    const setOp = gsap.quickSetter([rImg, cImg], "opacity");
    let splitOn = false;
    let velocity = 0, smooth = 0;

    ScrollTrigger.create({ start: 0, end: "max", onUpdate: (self) => { velocity = self.getVelocity(); } });

    gsap.ticker.add(() => {
      smooth += (velocity - smooth) * 0.12;
      velocity *= 0.9;
      const n = gsap.utils.clamp(-1, 1, smooth / 3000);
      if (cam.style.visibility === "hidden") return; // moon is covered by the section video
      setRy(n * 30); setCy(n * -30);
      setRx(n * 10); setCx(n * -10);
      const op = Math.min(Math.abs(n) * 1.4, 0.55);
      if (op > 0.01 !== splitOn) {
        splitOn = op > 0.01;
        rImg.style.visibility = cImg.style.visibility = splitOn ? "visible" : "hidden";
      }
      setOp(op);
    });

    ScrollTrigger.refresh();
  }

  /* ---------------------------------------------------------
     Box glitch — random short bursts on boxes that are on screen,
     plus one on hover
     --------------------------------------------------------- */
  function initBoxGlitch() {
    const boxes = $$(".card, .gig");
    const burst = (el) => {
      if (!el.classList.contains("is-done") || el.classList.contains("is-glitching")) return;
      el.style.setProperty("--gy", `${8 + Math.random() * 80}%`);
      el.classList.add("is-glitching");
      setTimeout(() => el.classList.remove("is-glitching"), 450); // timer, not animationend: still fires in background tabs
    };
    boxes.forEach((el) => el.addEventListener("mouseenter", () => burst(el)));
    if (reduceMotion) return;

    const onScreen = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => (en.isIntersecting ? onScreen.add(en.target) : onScreen.delete(en.target)));
    });
    boxes.forEach((b) => io.observe(b));

    const loop = () => {
      const list = [...onScreen];
      if (list.length && !document.hidden) burst(list[(Math.random() * list.length) | 0]);
      gsap.delayedCall(gsap.utils.random(1.6, 4), loop);
    };
    gsap.delayedCall(3, loop);
  }

  /* ---------------------------------------------------------
     Moon dust — floating particles that streak as you descend
     --------------------------------------------------------- */
  function initDust() {
    const canvas = $(".stage__dust");
    const ctx = canvas.getContext("2d");
    let w, h, dpr;
    const N = innerWidth < 700 ? 45 : 90;
    const parts = [];

    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      w = canvas.width = innerWidth * dpr;
      h = canvas.height = innerHeight * dpr;
    };
    resize();
    addEventListener("resize", resize);

    for (let i = 0; i < N; i++) {
      parts.push({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, tw: Math.random() * Math.PI * 2 });
    }

    let lastY = scrollY, cleared = false;
    gsap.ticker.add(() => {
      const dy = scrollY - lastY;
      lastY = scrollY;
      if (+canvas.style.opacity === 0 && canvas.style.opacity !== "") {
        if (!cleared) { ctx.clearRect(0, 0, w, h); cleared = true; }
        return;
      }
      cleared = false;
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      for (const p of parts) {
        const move = (dy / innerHeight) * p.z * 1.4;
        p.y -= move + 0.00025 * p.z;
        p.x += Math.sin(p.tw += 0.01) * 0.0002;
        if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
        if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }

        const x = p.x * w, y = p.y * h;
        const streak = Math.min(Math.abs(move) * h * 1.2, 120 * dpr);
        const a = 0.15 + p.z * 0.45;
        ctx.strokeStyle = p.z > 0.85 ? `rgba(252,238,10,${a})` : `rgba(200,240,255,${a})`;
        ctx.lineWidth = (0.6 + p.z * 1.6) * dpr;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + (move > 0 ? streak : -streak) + 0.1);
        ctx.stroke();
      }
    });
  }

  /* ---------------------------------------------------------
     Custom cursor (mouse only)
     --------------------------------------------------------- */
  function initCursor() {
    if (!matchMedia("(pointer: fine)").matches) return;
    const cur = $(".cursor");
    const dot = $(".cursor__dot");
    const ring = $(".cursor__ring");
    document.body.classList.add("has-cursor");

    const dotX = gsap.quickTo(dot, "x", { duration: 0.08 });
    const dotY = gsap.quickTo(dot, "y", { duration: 0.08 });
    const ringX = gsap.quickTo(ring, "x", { duration: 0.35, ease: "power3" });
    const ringY = gsap.quickTo(ring, "y", { duration: 0.35, ease: "power3" });

    addEventListener("mousemove", (e) => { dotX(e.clientX); dotY(e.clientY); ringX(e.clientX); ringY(e.clientY); });
    addEventListener("mousedown", () => cur.classList.add("is-down"));
    addEventListener("mouseup", () => cur.classList.remove("is-down"));
    document.addEventListener("mouseover", (e) => {
      cur.classList.toggle("is-hover", !!e.target.closest("a, button, .gig"));
    });
  }

  /* ---------------------------------------------------------
     3D tilt on gig cards
     --------------------------------------------------------- */
  function initTilt() {
    if (!matchMedia("(pointer: fine)").matches) return;
    $$(".gig").forEach((card) => {
      card.addEventListener("mousemove", (e) => {
        if (!card.classList.contains("is-done")) return;
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        gsap.to(card, { rotateY: px * 14, rotateX: -py * 14, y: -8, transformPerspective: 800, duration: 0.4, ease: "power2.out" });
      });
      card.addEventListener("mouseleave", () => {
        gsap.to(card, { rotateY: 0, rotateX: 0, y: 0, duration: 0.7, ease: "elastic.out(1, 0.5)" });
      });
    });
  }

  /* ---------------------------------------------------------
     Text scramble
     --------------------------------------------------------- */
  function scramble(el) {
    const final = el.dataset.final || el.textContent;
    el.dataset.final = final;
    const glyphs = "!<>-_\\/[]{}=+*^?#01ΞΔ¥";
    let frame = 0;
    const total = 32;
    const tick = () => {
      el.textContent = [...final].map((c, i) => {
        if (c === " " || c === "_") return c;
        return frame / total > i / final.length ? c : glyphs[(Math.random() * glyphs.length) | 0];
      }).join("");
      if (++frame > total) { gsap.ticker.remove(tick); el.textContent = final; }
    };
    gsap.ticker.add(tick);
  }

  /* ---------------------------------------------------------
     Dev shortcut: index.html?skip jumps straight to the site
     --------------------------------------------------------- */
  if (new URLSearchParams(location.search).has("skip")) {
    started = true;
    intro.remove();
    trans.remove();
    musicOk = false;
    revealSite();
  }
})();
