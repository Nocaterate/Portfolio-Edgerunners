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
  const SONG_URL = "assets/music.mp3";
  let songReady = Promise.resolve();
  const MOON_DISTANCE = 384400; // km, drives the HUD altitude readout
  const DIVE_START_ALT = 68114;  // from this readout the camera dives down onto the moon surface

  // The altitude readout counts down to 000000 exactly at the landing (About reaching 25% from
  // the top), so sections added further down never shift where 077812 / 068114 happen.
  let landingY = 1;
  const measureLanding = () => {
    const about = document.querySelector("#about");
    if (about) landingY = Math.max(1, about.getBoundingClientRect().top + scrollY - innerHeight * 0.25);
  };
  const altToScroll = (alt) => landingY * (1 - Math.cbrt(alt / MOON_DISTANCE));
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
    // The song plays from an in-memory copy (blob URL), which is always seekable.
    // Starting on the lyric and looping both seek, and not every server supports
    // Range requests (without them the browser can't seek, so the loop silently fails).
    songReady = fetch(SONG_URL)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((blob) => { bgm.src = URL.createObjectURL(blob); })
      .catch(() => { bgm.src = SONG_URL; }) // e.g. opened straight from disk (file://)
      .then(() => whenMedia(bgm));
    const jobs = [
      new Promise((r) => (bgImg.complete ? r() : (bgImg.onload = bgImg.onerror = r))).then(() => bgImg.decode().catch(() => {})),
      songReady,
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
    if (bgm.currentSrc) {
      bgm.play().then(() => {
        if (!musicStarted) { bgm.pause(); bgm.currentTime = SONG_START; }
      }).catch(() => { musicOk = false; });
    } // else: still downloading; the click already allows playback, startMusic waits for it

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
    initGigFiles();
    initComms();
    initBreach();

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
    if (!bgm.currentSrc) { songReady.then(() => startMusic(fade, partner)); return; } // still downloading
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

  // Safety net: `loop` should never let the song end, but if a loop ever fails, restart it by hand
  bgm.addEventListener("ended", () => {
    bgm.currentTime = 0;
    bgm.play().catch(() => {});
  });

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
    const end = altToScroll(BOOST_END_ALT);
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
      const gs = smoothstep(0, 0.12, p); // scroll glitch ramps in
      const g = Math.max(gs, idle);      // idle bursts glitch the crisp title too

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
      const split = ((2 + 10 * p) * gs + 6 * idle) * dpr;
      const glow = (20 + beat * 40) * (1 - p) * dpr;
      const bands = [];
      if (g > 0) {
        let y = 0;
        while (y < H) {
          const bh = 3 + Math.random() * 16;
          const jump = Math.random() < 0.12 + 0.45 * p + 0.22 * idle
            ? (Math.random() - 0.5) * (90 * p * gs + 52 * idle) : 0;
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

    // Idle glitch: while the title sits crisp, throw a short burst every 2–5 s
    // (sometimes a quick double-hit)
    let idle = 0, burstUntil = 0, nextBurst = 0;
    const idleGlitch = (now) => {
      if (reduceMotion || !revealed || fx.p > 0.02) { nextBurst = now + 2500; return 0; }
      if (now >= nextBurst) {
        burstUntil = now + gsap.utils.random(150, 300);
        nextBurst = Math.random() < 0.35 ? burstUntil + 110 : now + gsap.utils.random(2000, 5000);
      }
      return now < burstUntil ? (Math.random() < 0.75 ? 1 : 0.35) : 0;
    };

    // Redraw while the title is on screen and something changed
    let lastP = -1, lastBeat = -1, lastIdle = 0;
    gsap.ticker.add(() => {
      if (scrollY > innerHeight * 3) return;
      idle = idleGlitch(performance.now());
      const beat = h2.style.getPropertyValue("--beat");
      const animating = fx.p > 0.001 && fx.p < 0.999;
      if (animating || idle || lastIdle || fx.p !== lastP || beat !== lastBeat) render();
      lastP = fx.p; lastBeat = beat; lastIdle = idle;
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

    // --- HERO: text fades, title pixel-dissolves, quote (the camera is driven by the rig below) ---
    gsap.timeline({
      scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom bottom", scrub: 1.2, invalidateOnRefresh: true },
      defaults: { ease: "none" },
    })
      .to([".hero__kicker", ".hero__sub", ".hero__scroll"], {
        opacity: 0, y: -60, filter: "blur(6px)", duration: 0.22, stagger: 0.03,
      }, 0)
      .to(titleFx, { p: 1, duration: 0.55, ease: "none" }, 0.03)
      .fromTo(".hero__quote",
        { opacity: 0, letterSpacing: "0.6em", y: 30, filter: "blur(8px)" },
        { opacity: 1, letterSpacing: "0.12em", y: 0, filter: "blur(0px)", duration: 0.2 }, 0.45)
      .to(".hero__quote", { opacity: 0, y: -40, filter: "blur(8px)", duration: 0.15 }, 0.85);

    // keep the landing point (and so every readout-based position) current on each refresh
    measureLanding();
    ScrollTrigger.addEventListener("refreshInit", measureLanding);

    // --- CAMERA RIG -------------------------------------------------------------
    // Zoom / tilt / pan / darkness are ONE function of scroll position with ONE shared
    // smoothing. (Four separately-scrubbed timelines used to fight over the camera
    // while catching up, which made it snap: random zoom-out / zoom-in.)
    //   hero   0 → heroEnd          push in on David & Lucy
    //   drift  heroEnd → diveStart  slow push + tilt
    //   dive   diveStart → about    glide down onto the moon surface (from 068114 km)
    //   portal about enters → 25%   plunge into the surface
    const marks = { heroEnd: 1, diveStart: 2, portalStart: 3, portalEnd: 4 };
    const docTop = (el) => el.getBoundingClientRect().top + scrollY;
    const measure = () => {
      const vh = innerHeight;
      const hero = $(".hero"), aboutTop = docTop($("#about"));
      marks.heroEnd = docTop(hero) + hero.offsetHeight - vh;
      marks.diveStart = Math.max(marks.heroEnd + 1, altToScroll(DIVE_START_ALT));
      marks.portalStart = Math.max(marks.diveStart + 1, aboutTop - vh);
      marks.portalEnd = Math.max(marks.portalStart + 1, aboutTop - vh * 0.25);
    };
    ScrollTrigger.addEventListener("refresh", measure);

    const ease = {
      p1io: gsap.parseEase("power1.inOut"), p1in: gsap.parseEase("power1.in"),
      p2io: gsap.parseEase("power2.inOut"), p2in: gsap.parseEase("power2.in"),
    };
    const seg = (y, a, b) => gsap.utils.clamp(0, 1, (y - a) / (b - a));

    function camTarget(y) {
      const g = geo();
      const h = seg(y, 0, marks.heroEnd);
      const d = seg(y, marks.heroEnd, marks.diveStart);
      const v = seg(y, marks.diveStart, marks.portalStart);
      const w = seg(y, marks.portalStart, marks.portalEnd);
      const push = ease.p1io(Math.min(h / 0.7, 1));
      return {
        scale: 1 + 0.32 * push + 0.06 * d - 0.30 * ease.p1io(v) + 0.82 * ease.p2in(w),
        rot: -1.5 * push - 1.0 * d + 3.0 * ease.p1io(v),
        tilt: 9 * Math.sin(Math.PI * gsap.utils.clamp(0, 1, (v - 0.1) / 0.8)),
        panY: g.yStart + (g.yMid - g.yStart) * ease.p1in(h) + (g.yEnd - g.yMid) * ease.p2io(v),
        dim: 0.15 * seg(h, 0.6, 1) + 0.75 * ease.p1in(seg(w, 0.1, 0.65)),
      };
    }

    gsap.set(cam, { transformPerspective: 1400 });
    const setSX = gsap.quickSetter(cam, "scaleX"), setSY = gsap.quickSetter(cam, "scaleY"); // quickSetter has no "scale" shorthand
    const apply = {
      scale: (v) => { setSX(v); setSY(v); },
      rot: gsap.quickSetter(cam, "rotation", "deg"),
      tilt: gsap.quickSetter(cam, "rotationX", "deg"),
      panY: gsap.quickSetter(pan, "y", "px"),
      dim: gsap.quickSetter(dim, "opacity"),
    };
    let camNow = null;
    gsap.ticker.add((time, deltaMs) => {
      const target = camTarget(scrollY);
      if (!camNow) camNow = { ...target };
      const k = 1 - Math.pow(1 - 0.09, (deltaMs || 16.7) / 16.7); // same feel at any frame rate
      let moving = false;
      for (const key in target) {
        const diff = target[key] - camNow[key];
        if (Math.abs(diff) > 1e-4) { camNow[key] += diff * k; moving = true; }
      }
      if (moving) for (const key in apply) apply[key](camNow[key]);
    });

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
        const descent = gsap.utils.clamp(0, 1, scrollY / landingY);
        alt.textContent = String(Math.round(MOON_DISTANCE * Math.pow(1 - descent, 3))).padStart(6, "0");
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
    measure();
  }

  /* ---------------------------------------------------------
     GIG FILES — click a project box to open its summary
     --------------------------------------------------------- */
  const GIGS = {
    nocasiem: {
      id: "#001", title: "NocaSIEM", category: "SECURITY / SIEM",
      overview: "NocaSIEM is a self-hosted Security Information and Event Management rig. It pulls in logs from Windows, Linux, routers, firewalls and web servers over syslog, then runs every line past 65 detection rules mapped to MITRE ATT&CK to flag shady activity in real time.",
      problem: "Most small crews and home labs are flying blind. With no central place collecting and correlating logs, attacks and misconfigs slip by unnoticed till it's way too late.",
      solution: "NocaSIEM hoovers up every log over syslog, ranks detections by severity against MITRE ATT&CK, and throws alerts onto a dashboard that updates live. Full-text log search and a built-in attack simulator let you test your detections before the real gonks show up.",
      links: [["GITHUB ▸", "https://github.com/Nocaterate/NocaSIEM"]],
      images: 3,
    },
    cuciyuk: {
      id: "#002", title: "CuciYuk!", category: "WEB APP",
      overview: "CuciYuk! is an online laundry platform. Book and manage pickups and deliveries straight from your phone or browser.",
      problem: "Plenty of chooms are too busy, or too lazy, to do their own laundry, and the usual options are a pain to book.",
      solution: "CuciYuk! turns ordering laundry into a few taps, with express scheduling and order tracking in a clean, no-nonsense app.",
      links: [["GITHUB ▸", "https://github.com/Nocaterate/CuciYuk"]],
      images: 3,
    },
    "batara-kuwera": {
      id: "#003", title: "Batara Kuwera", category: "FINTECH",
      overview: "Batara Kuwera is a personal finance rig that tracks spending, budgets and overall financial health, all in one place.",
      problem: "Plenty of people burn through their eddies without knowing how to split or manage 'em. Spending happens way faster than tracking does.",
      solution: "Batara Kuwera lays your spending patterns bare and gives you guidance on budgeting and allocation, so every eurodollar goes where you actually meant it to.",
      links: [["GITHUB ▸", "https://github.com/Nocaterate/Batara-Kuwera"], ["LIVE DEMO ▸", "https://batarakuwera.web.id"]],
      images: 3,
    },
  };

  function initGigFiles() {
    const brief = $("#brief");
    const panel = $(".brief__panel", brief);
    const img = $(".brief__img", brief);
    const dots = $(".brief__dots", brief);
    const count = $(".brief__count", brief);
    const prevBtn = $(".brief__nav--prev", brief);
    const nextBtn = $(".brief__nav--next", brief);
    let gig = null, slug = "", index = 0, opener = null;

    const src = (i) => `assets/projects/${slug}-${i + 1}.jpg`;

    function show(i, swap = true) {
      index = (i + gig.images) % gig.images;
      img.src = src(index);
      img.alt = `${gig.title} screenshot ${index + 1}`;
      count.textContent = `${index + 1} / ${gig.images}`;
      [...dots.children].forEach((d, k) => d.classList.toggle("is-active", k === index));
      if (swap && !reduceMotion) {
        img.classList.remove("is-swap");
        void img.offsetWidth; // restart the glitch swap
        img.classList.add("is-swap");
      }
    }

    function open(key, from) {
      gig = GIGS[key];
      if (!gig) return;
      slug = key; opener = from;
      gsap.killTweensOf(panel); // reopening mid-close must not get hidden by the close animation
      gsap.set(panel, { clearProps: "opacity,scale" });

      $(".brief__id", brief).textContent = gig.id;
      $(".brief__cat", brief).textContent = gig.category;
      $(".brief__title", brief).textContent = gig.title;
      $(".brief__overview", brief).textContent = gig.overview;
      $(".brief__problem", brief).textContent = gig.problem;
      $(".brief__solution", brief).textContent = gig.solution;
      $(".brief__links", brief).replaceChildren(...gig.links.map(([label, href]) => {
        const a = document.createElement("a");
        a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = label;
        return a;
      }));
      dots.replaceChildren(...Array.from({ length: gig.images }, (_, k) => {
        const b = document.createElement("button");
        b.type = "button"; b.setAttribute("aria-label", `Screenshot ${k + 1}`);
        b.addEventListener("click", () => show(k));
        return b;
      }));
      const multi = gig.images > 1;
      prevBtn.hidden = nextBtn.hidden = dots.hidden = count.hidden = !multi;
      for (let k = 0; k < gig.images; k++) new Image().src = src(k); // preload the slides
      show(0, false);

      brief.hidden = false;
      panel.scrollTop = 0;
      if (lenis) lenis.stop();
      void brief.offsetWidth; // flush styles so the backdrop fade-in transition runs
      brief.classList.add("is-open");
      if (!reduceMotion) {
        panel.style.setProperty("--gy", `${20 + Math.random() * 60}%`);
        panel.classList.remove("glitch-in");
        void panel.offsetWidth;
        panel.classList.add("glitch-in");
        setTimeout(() => panel.classList.remove("glitch-in"), 800);
      }
      $(".brief__close", brief).focus({ preventScroll: true });
    }

    function close() {
      if (brief.hidden || !brief.classList.contains("is-open")) return;
      brief.classList.remove("is-open");
      gsap.to(panel, {
        opacity: 0, scale: 0.97, duration: 0.2, ease: "power2.in",
        onComplete: () => { brief.hidden = true; gsap.set(panel, { clearProps: "opacity,scale" }); },
      });
      if (lenis) lenis.start();
      if (opener) opener.focus({ preventScroll: true });
    }

    // open from the project boxes (click, Enter or Space)
    $$(".gig[data-project]").forEach((card) => {
      card.addEventListener("click", () => open(card.dataset.project, card));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(card.dataset.project, card); }
      });
    });

    brief.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
    prevBtn.addEventListener("click", () => show(index - 1));
    nextBtn.addEventListener("click", () => show(index + 1));

    document.addEventListener("keydown", (e) => {
      if (brief.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowLeft" && gig.images > 1) show(index - 1);
      else if (e.key === "ArrowRight" && gig.images > 1) show(index + 1);
      else if (e.key === "Tab") {
        // keep keyboard focus inside the gig file
        const items = [...panel.querySelectorAll("button:not([hidden]), a[href]")].filter((el) => !el.closest("[hidden]"));
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /* ---------------------------------------------------------
     COMMS — encrypted channels: handles churn as glitch glyphs,
     decrypt on hover / focus (or when scrolled into view on touch)
     --------------------------------------------------------- */
  function initComms() {
    const GLYPHS = "!<>-_\\/[]{}=+*^?#01ΞΔ¥▓▒░";
    const HEXES = ["1C", "55", "BD", "E9", "7A", "FF"];
    const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
    const hexRow = () => Array.from({ length: 6 }, () => HEXES[(Math.random() * HEXES.length) | 0]).join(" ");
    const esc = (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] || c);
    const touch = matchMedia("(hover: none)").matches;

    const chans = $$(".chan").map((el) => {
      const c = {
        el,
        handle: el.dataset.handle,
        out: $(".chan__handle", el),
        hex: $(".chan__hex", el),
        state: $(".chan__state", el),
        d: reduceMotion ? 1 : 0, // 0 = scrambled, 1 = clear
        visible: false,
        tween: null,
      };
      c.render = () => {
        const n = c.handle.length;
        const clear = Math.round(c.d * n);
        let html = "";
        for (let i = 0; i < n; i++) {
          const ch = c.handle[i];
          if (i < clear || ch === "@") html += esc(ch);
          else if (Math.random() < 0.12) html += `<b class="leak">${esc(ch)}</b>`; // signal leaking through
          else html += `<b>${esc(glyph())}</b>`;
        }
        c.out.innerHTML = html;
      };
      c.setState = () => {
        const open = c.d >= 1;
        el.classList.toggle("is-decrypted", open);
        c.state.textContent = open ? "LINK ESTABLISHED" : c.d > 0 ? "DECRYPTING..." : "ENCRYPTED";
      };
      c.to = (target) => {
        if (reduceMotion) return;
        if (c.tween) c.tween.kill();
        c.tween = gsap.to(c, {
          d: target, duration: target ? 0.7 : 0.4, ease: target ? "power1.inOut" : "power2.in",
          onUpdate: () => { c.render(); c.hex.textContent = hexRow(); c.setState(); },
          onComplete: () => { c.render(); c.setState(); },
        });
      };
      c.render(); c.setState();

      if (!touch) {
        el.addEventListener("mouseenter", () => c.to(1));
        el.addEventListener("mouseleave", () => c.to(0));
      }
      el.addEventListener("focus", () => c.to(1));
      el.addEventListener("blur", () => c.to(0));
      return c;
    });

    // only churn the channels that are on screen; on touch screens they decrypt themselves
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      const c = chans.find((x) => x.el === en.target);
      c.visible = en.isIntersecting;
      if (touch) setTimeout(() => c.to(c.visible ? 1 : 0), c.visible ? 700 : 0);
    }), { threshold: 0.4 });
    chans.forEach((c) => io.observe(c.el));

    // idle churn: scrambled glyphs keep shifting, the hex row ticks over
    if (reduceMotion) return;
    let acc = 0;
    gsap.ticker.add((time, dt) => {
      acc += dt;
      if (acc < 75) return; // ~13 updates a second is plenty for a glitchy churn
      acc = 0;
      for (const c of chans) {
        if (!c.visible || c.d >= 1 || (c.tween && c.tween.isActive())) continue;
        c.render();
        if (Math.random() < 0.3) c.hex.textContent = hexRow();
      }
    });
  }

  /* ---------------------------------------------------------
     BREACH PROTOCOL — the Cyberpunk hacking minigame.
     Pick from the top row, then alternate column / row / column…
     Every pick goes into the buffer; upload every target sequence
     (as an unbroken run in the buffer) before the buffer fills.
     --------------------------------------------------------- */
  function initBreach() {
    const root = $("#bp");
    if (!root) return;
    const CODES = ["1C", "55", "BD", "E9", "7A", "FF"];
    const MODES = {
      normal: { size: 4, buffer: 6, seqs: [5, 3] }, // like the collab's Normal stage
      hard:   { size: 5, buffer: 7, seqs: [5, 4] },
    };
    const LOOT = [
      ["LEGENDARY", "Sandevistan Mk.5"],
      ["EPIC", "Lucy's Monowire"],
      ["ICONIC", "One-way ticket to the Moon"],
      ["RARE", "Kiroshi Optics v2.0"],
      ["EPIC", "Militech-grade ICE breaker"],
      ["ICONIC", "David's yellow jacket"],
    ];

    const grid = $(".bp-grid", root);
    const turn = $(".bp-turn", root);
    const seqList = $(".bp-seq-list", root);
    const slots = $(".bp-slots", root);
    const count = $(".bp-count", root);
    const result = $(".bp-result", root);
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];

    let mode = "normal", cfg = MODES.normal;
    let matrix = [], seqs = [];
    let picks = [], used = new Set(), over = false, hover = null;

    // a legal path through the matrix: row 0 first, then alternate column / row
    function makePath(size, len) {
      for (let attempt = 0; attempt < 500; attempt++) {
        let r = 0, c = (Math.random() * size) | 0;
        const path = [[r, c]], seen = new Set([r * size + c]);
        for (let i = 1; i < len; i++) {
          const inColumn = i % 2 === 1;
          const options = [];
          for (let k = 0; k < size; k++) {
            const rr = inColumn ? k : r, cc = inColumn ? c : k;
            if (!seen.has(rr * size + cc)) options.push([rr, cc]);
          }
          if (!options.length) break;
          [r, c] = pick(options);
          path.push([r, c]); seen.add(r * size + c);
        }
        if (path.length === len) return path;
      }
      return null;
    }

    // build a puzzle that is always solvable by the generated path
    function generate() {
      const { size, buffer, seqs: lens } = cfg;
      for (let attempt = 0; attempt < 100; attempt++) {
        const path = makePath(size, buffer);
        const solution = Array.from({ length: buffer }, () => pick(CODES));
        const a = solution.slice(0, lens[0]);                 // overlapping sequences,
        const b = solution.slice(buffer - lens[1]);           // like BD 1C FF 7A BD + 7A BD 55
        const ja = a.join(" "), jb = b.join(" ");
        if (ja.includes(jb) || jb.includes(ja)) continue;     // one would make the other trivial
        matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => pick(CODES)));
        path.forEach(([r, c], i) => { matrix[r][c] = solution[i]; });
        seqs = Math.random() < 0.5 ? [a, b] : [b, a];
        return;
      }
    }

    const lineOf = () => {
      if (!picks.length) return { axis: "row", index: 0 };
      const [r, c] = picks[picks.length - 1];
      return picks.length % 2 === 1 ? { axis: "col", index: c } : { axis: "row", index: r };
    };
    const inLine = (r, c, line = lineOf()) => (line.axis === "row" ? r === line.index : c === line.index);
    const buffer = () => picks.map(([r, c]) => matrix[r][c]);

    // how far each sequence has got: done, how many codes the buffer's tail already matches, or dead
    function seqStatus(buf) {
      const s = buf.join(" ");
      return seqs.map((seq) => {
        if (s.includes(seq.join(" "))) return { done: true, hit: seq.length };
        let hit = 0;
        for (let k = Math.min(seq.length - 1, buf.length); k > 0; k--) {
          if (buf.slice(-k).join(" ") === seq.slice(0, k).join(" ")) { hit = k; break; }
        }
        const left = cfg.buffer - buf.length;
        return { done: false, hit, dead: left < seq.length - hit };
      });
    }

    function render() { renderGrid(); renderSide(); }

    function renderGrid() {
      const line = lineOf();
      const size = cfg.size;
      grid.style.gridTemplateColumns = `repeat(${size}, auto)`;
      grid.replaceChildren(...matrix.flatMap((row, r) => row.map((code, c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bp-cell";
        b.dataset.r = r; b.dataset.c = c;
        const isUsed = used.has(r * size + c);
        const active = !over && inLine(r, c, line);
        if (isUsed) { b.classList.add("is-used"); b.textContent = "[ ]"; }
        else b.textContent = code;
        if (active) b.classList.add("is-line");
        b.disabled = !active || isUsed;
        b.setAttribute("aria-label", isUsed ? "used" : `${code}, row ${r + 1}, column ${c + 1}`);
        return b;
      })));
    }

    // sequences, buffer and turn hint (cheap: safe to redo on every hover)
    function renderSide() {
      const line = lineOf();
      const buf = buffer();
      const next = hover ? [...buf, matrix[hover[0]][hover[1]]] : buf;
      const status = seqStatus(buf);
      const preview = hover ? seqStatus(next) : null;
      seqList.replaceChildren(...seqs.map((seq, i) => {
        const st = status[i];
        const li = document.createElement("li");
        li.className = "bp-seq" + (st.done ? " is-done" : st.dead ? " is-dead" : "");
        seq.forEach((code, k) => {
          const span = document.createElement("span");
          span.className = "bp-seq__code";
          if (!st.done && k < st.hit) span.classList.add("is-hit");
          else if (!st.done && preview && k < preview[i].hit && !preview[i].done) span.classList.add("is-hint");
          span.textContent = code;
          li.appendChild(span);
        });
        const state = document.createElement("span");
        state.className = "bp-seq__state";
        state.textContent = st.done ? "UPLOADED" : st.dead ? "FAILED" : `${st.hit}/${seq.length}`;
        li.appendChild(state);
        return li;
      }));

      slots.replaceChildren(...Array.from({ length: cfg.buffer }, (_, i) => {
        const s = document.createElement("span");
        s.className = "bp-slot";
        if (i < buf.length) { s.classList.add("is-filled"); s.textContent = buf[i]; }
        else if (i === buf.length && hover) { s.classList.add("is-ghost"); s.textContent = matrix[hover[0]][hover[1]]; }
        return s;
      }));
      count.textContent = `${buf.length}/${cfg.buffer}`;
      turn.textContent = over ? "" : line.axis === "row"
        ? (picks.length ? `> PICK FROM ROW ${line.index + 1}` : "> PICK FROM THE TOP ROW")
        : `> PICK FROM COLUMN ${line.index + 1}`;
    }

    function crosshair(r, c) {
      $$(".bp-cell", grid).forEach((el) => {
        const rr = +el.dataset.r, cc = +el.dataset.c;
        // the next line you'd be locked to after this pick
        const nextIsCol = picks.length % 2 === 0;
        el.classList.toggle("is-cross", r !== null && (nextIsCol ? cc === c : rr === r) && !(rr === r && cc === c));
      });
    }

    function choose(r, c) {
      if (over || used.has(r * cfg.size + c) || !inLine(r, c)) return;
      picks.push([r, c]);
      used.add(r * cfg.size + c);
      hover = null;
      render();
      const cell = grid.querySelector(`[data-r="${r}"][data-c="${c}"]`);
      if (cell) cell.classList.add("is-pick");
      check();
    }

    function check() {
      const status = seqStatus(buffer());
      if (status.every((s) => s.done)) return finish(true);
      const line = lineOf();
      const movesLeft = matrix.some((row, r) => row.some((_, c) => inLine(r, c, line) && !used.has(r * cfg.size + c)));
      if (picks.length >= cfg.buffer || status.some((s) => s.dead) || !movesLeft) finish(false);
    }

    function finish(win) {
      over = true;
      render();
      $(".bp-result__kicker", result).textContent = win ? "// BREACH SUCCESSFUL" : "// BREACH FAILED";
      $(".bp-result__title", result).textContent = win ? "ICE CRACKED, CHOOM" : "FLATLINED";
      $(".bp-result__text", result).textContent = win
        ? "Every daemon uploaded. Preem work, netrunner."
        : "The ICE fried your buffer. Shake it off and jack back in.";
      const items = $(".bp-result__items", result);
      items.replaceChildren(...(win ? [...LOOT].sort(() => Math.random() - 0.5).slice(0, 3) : []).map(([tier, name]) => {
        const li = document.createElement("li");
        li.innerHTML = `<b>[${tier}]</b>`;
        li.append(name);
        return li;
      }));
      items.hidden = !win;
      $(".bp-retry", result).hidden = win;
      result.classList.toggle("is-fail", !win);
      setTimeout(() => {
        result.hidden = false;
        const panel = $(".bp-result__panel", result);
        if (!reduceMotion) {
          panel.classList.remove("glitch-in"); void panel.offsetWidth; panel.classList.add("glitch-in");
          setTimeout(() => panel.classList.remove("glitch-in"), 800);
        }
        (win ? $(".bp-new", result) : $(".bp-retry", result)).focus({ preventScroll: true });
      }, win ? 450 : 650);
    }

    function reset(newPuzzle) {
      if (newPuzzle) generate();
      picks = []; used = new Set(); over = false; hover = null;
      result.hidden = true;
      render();
    }

    // events
    grid.addEventListener("click", (e) => {
      const b = e.target.closest(".bp-cell");
      if (b && !b.disabled) choose(+b.dataset.r, +b.dataset.c);
    });
    // hover / focus previews the pick: ghost code in the buffer, sequence hints, next-line crosshair
    const onHover = (e) => {
      const b = e.target.closest(".bp-cell");
      const next = b && !b.disabled ? [+b.dataset.r, +b.dataset.c] : null;
      if (String(next) === String(hover)) return;
      hover = next;
      renderSide();
      crosshair(hover ? hover[0] : null, hover ? hover[1] : null);
    };
    grid.addEventListener("mouseover", onHover);
    grid.addEventListener("focusin", onHover);
    grid.addEventListener("mouseleave", () => { hover = null; renderSide(); crosshair(null, null); });

    root.addEventListener("click", (e) => {
      if (e.target.closest(".bp-reset, .bp-retry")) reset(false);
      else if (e.target.closest(".bp-new")) reset(true);
      const diff = e.target.closest("[data-diff]");
      if (diff && diff.dataset.diff !== mode) {
        mode = diff.dataset.diff; cfg = MODES[mode];
        $$("[data-diff]", root).forEach((b) => b.setAttribute("aria-pressed", String(b === diff)));
        reset(true);
      }
    });

    generate();
    render();
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
