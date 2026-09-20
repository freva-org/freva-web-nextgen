// Freva badge
//
// Load order and memory are the whole point of this file:
//   - nothing but the mark and these few kilobytes at page load;
//   - the footer story sheet when the browser is idle;
//   - the flight and walk sprites only once someone shows intent;
//   - drawing surfaces sized to the animation, allocated on open, released on close;
//   - one paint per source frame, none while hidden, none while closed.
(function (global) {
  'use strict';

  var G = {"vb":[1000,1025],"text":[126,250,800,590],"amber":[778,48,215,202],"rim":[[0.0,451.9],[5.9,383.7],[11.7,352.2],[17.6,326.5],[23.5,305.2],[29.3,286.9],[35.2,270.7],[41.1,256.1],[47.0,242.8],[52.8,229.6],[58.7,219.4],[64.6,209.1],[70.4,198.8],[76.3,190.0],[82.2,182.0],[88.0,173.9],[93.9,165.8],[99.8,159.2],[105.6,151.9],[111.5,145.3],[117.4,139.4],[123.3,132.8],[129.1,127.7],[135.0,121.1],[140.9,117.4],[146.7,112.3],[152.6,107.1],[158.5,102.7],[164.3,99.0],[170.2,94.6],[176.1,88.8],[182.0,85.8],[187.8,82.9],[193.7,79.2],[199.6,76.3],[205.4,71.9],[211.3,69.7],[217.2,66.0],[223.0,63.1],[228.9,60.2],[234.8,58.0],[240.6,55.0],[246.5,52.1],[252.4,49.9],[258.3,47.0],[264.1,44.8],[270.0,42.6],[275.9,40.4],[281.7,38.2],[287.6,36.0],[293.5,34.5],[299.3,32.3],[305.2,30.8],[311.1,28.6],[316.9,27.1],[322.8,25.7],[328.7,24.2],[334.6,22.0],[340.4,21.3],[346.3,19.8],[352.2,18.3],[358.0,16.9],[363.9,15.4],[369.8,14.7],[375.6,13.2],[381.5,12.5],[387.4,11.0],[393.3,10.3],[399.1,9.5],[405.0,8.8],[410.9,7.3],[416.7,6.6],[422.6,5.1],[428.5,5.1],[434.3,5.1],[440.2,4.4],[446.1,3.7],[451.9,2.2],[457.8,2.9],[463.7,1.5],[469.6,2.2],[475.4,1.5],[481.3,1.5],[487.2,0.7],[493.0,0.7],[498.9,0.7],[504.8,0.7],[510.6,0.7],[516.5,0.7],[522.4,0.7],[528.2,0.0],[534.1,1.5],[540.0,1.5],[545.9,1.5],[551.7,1.5],[557.6,2.2],[563.5,2.2],[569.3,2.2],[575.2,2.9],[581.1,2.9],[586.9,3.7],[592.8,3.7],[598.7,4.4],[604.5,5.1],[610.4,4.4],[616.3,6.6],[622.2,7.3],[628.0,8.1],[633.9,8.8],[639.8,10.3],[645.6,11.0],[651.5,11.7],[657.4,13.2],[663.2,13.9],[669.1,15.4],[675.0,16.9],[680.9,17.6],[686.7,19.1],[692.6,20.5],[698.5,21.3],[704.3,22.7],[710.2,24.2],[716.1,25.7],[721.9,27.1],[727.8,29.3],[733.7,30.8],[739.5,33.7],[745.4,286.1],[751.3,286.1],[757.2,286.1],[763.0,286.1],[768.9,286.1],[774.8,286.1],[780.6,50.6],[786.5,49.2],[792.4,50.6],[798.2,52.8],[804.1,55.0],[810.0,58.0],[815.8,60.2],[821.7,61.6],[827.6,63.8],[833.5,66.0],[839.3,69.0],[845.2,71.2],[851.1,74.1],[856.9,76.3],[862.8,79.2],[868.7,82.2],[874.5,85.1],[880.4,88.0],[886.3,91.0],[892.1,94.6],[898.0,98.3],[903.9,101.2],[909.8,105.6],[915.6,109.3],[921.5,113.7],[927.4,118.9],[933.2,123.3],[939.1,128.4],[945.0,134.3],[950.8,140.1],[956.7,147.5],[962.6,154.8],[968.5,164.3],[974.3,175.3],[980.2,187.8],[986.1,204.7],[991.9,232.6],[997.8,314.0]],"tilt":{"factor":1,"maxDeg":20,"spanVb":20},"badgeMark":{"cx":0.4922,"cy":0.4853,"w":0.3569,"h":0.9118},"story":{"frame":[255,102],"count":260,"cols":13,"rows":20,"fps":24},"markPaths":[["#0a487e","M325.75,24.21 L239.18,55.03 L192.22,79.97 L141.60,115.19 L90.98,169.48 L52.82,230.37 L31.55,280.26 L16.14,331.62 L5.87,387.38 L1.47,438.00 L1.47,504.04 L5.14,548.79 L13.94,600.88 L26.41,648.57 L61.63,734.41 L85.84,776.23 L110.05,809.98 L136.46,840.79 L179.02,881.14 L251.65,932.50 L304.48,960.38 L355.10,981.66 L415.26,1000.73 L476.16,1014.67 L526.78,1022.01 L574.47,1023.48 L645.63,1009.54 L724.87,974.32 L781.36,937.64 L839.33,889.95 L896.55,823.92 L936.90,755.69 L964.05,685.99 L983.86,604.55 L993.40,521.64 L743.21,521.64 L742.48,285.40 L504.04,285.40 L503.30,1.47 L422.60,5.14 Z"],["#5cbadf","M504.04,0.73 L504.04,284.67 L741.75,284.67 L741.75,39.62 L739.55,33.75 L695.52,20.54 L615.55,5.87 Z"],["#5cbadf","M743.21,286.13 L743.21,520.91 L993.40,520.91 L999.27,437.27 L999.27,351.43 L996.33,293.47 L992.66,286.87 Z"],["#f2a627","M779.90,51.36 L778.43,54.29 L778.43,242.85 L782.83,248.72 L794.57,250.92 L986.06,250.92 L992.66,247.98 L993.40,241.38 L987.53,209.83 L980.19,187.82 L964.05,157.01 L945.71,134.26 L914.89,108.58 L884.08,89.51 L840.79,68.97 L785.77,48.42 Z"]],"wedgePath":"M779.90,51.36 L778.43,54.29 L778.43,242.85 L782.83,248.72 L794.57,250.92 L986.06,250.92 L992.66,247.98 L993.40,241.38 L987.53,209.83 L980.19,187.82 L964.05,157.01 L945.71,134.26 L914.89,108.58 L884.08,89.51 L840.79,68.97 L785.77,48.42 Z"};

  var TILE_GEOMETRY = {
    docs: [504, 0, 238, 285],
    api: [743, 286, 257, 235]
  };
  var GROUND_START_FRAME = 3;
  var MOVING_BIRD_SCALE = 0.95;

  var content = global.FrevaBadgeContent || {};
  var COPY = content.copy;
  var ORGS = content.orgs || [];
  var LINKS = content.links || {};

  var opts = global.FrevaBadgeOptions || {};
  var BASE = (opts.assetBase || 'assets/').replace(/\/?$/, '/');

  var calm = matchMedia('(prefers-reduced-motion: reduce)');
  var canHover = matchMedia('(hover: hover)');
  var conn = navigator.connection || {};
  // A still presentation for anyone who has asked not to be animated at, and for anyone on a
  // metered connection. Neither downloads a sprite sheet.
  function wantsStill() { return calm.matches || conn.saveData === true; }

  // One scale set covers the bird: it is drawn at min(70, popWidth * 0.21) * 0.95 CSS px over a
  // 176-unit source box, so a device pixel ratio of 2 needs 0.7557 source px per device px. The 2x
  // assets are built at 0.78 and the 1x at 0.39; more than that is resolution no screen can show.
  function scaleKey() {
    // `quality: 'standard'` pins the 1x set. A deployment that would rather spend a megabyte
    // than have the bird be soft on a Retina panel asks for 'auto', the density rule below and
    // the default.
    if (opts.quality === 'standard') return '1x';
    return (global.devicePixelRatio || 1) > 1.25 ? '2x' : '1x';
  }

  // DOM
  // The badge builds its own markup so a host page only has to include the stylesheet, this file,
  // and an empty mount point.
  var root = document.createElement('div');
  root.className = 'fb';
  var badge, badgeMark, badgeStill, badgeLive, badgeFrames, pop, popIn, popBody, popLines,
      popClose, docsTile, apiTile, popContact, featherCanvas, featherCtx,
      canvas, ctx;

  var MARK_SVG = '<svg viewBox="0 0 1000 1025" aria-hidden="true" focusable="false">' +
    G.markPaths.map(function (p) { return '<path fill="' + p[0] + '" d="' + p[1] + '"/>'; }).join('') +
    '</svg>';

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function tileMarkup(cls, id, link, icon) {
    return '<a class="logo-tile logo-tile--' + cls + '" id="' + id + '"' +
      ' aria-label="' + link.aria + '" aria-expanded="false" href="' + link.href + '"' +
      ' target="_blank" rel="noopener noreferrer">' +
      '<span class="logo-tile__inner">' +
        '<span class="logo-tile__face logo-tile__face--front">' +
          '<span class="logo-tile__icon" aria-hidden="true">' + icon + '</span>' +
          '<span class="logo-tile__title">' + link.front + '</span>' +
        '</span>' +
        '<span class="logo-tile__face logo-tile__face--back">' +
          '<span class="logo-tile__title">' + link.backTitle + '</span>' +
          '<span class="logo-tile__copy">' + link.backCopy + '</span>' +
          '<span class="logo-tile__cta">' + link.cta + '</span>' +
        '</span>' +
      '</span></a>';
  }

  function build(mount) {
    badge = el('<button class="badge" id="fb-badge" aria-haspopup="dialog"' +
      ' aria-expanded="false" aria-controls="fb-pop" title="' + content.badgeTitle + '">' +
      '<span class="badge__mark" id="fb-badgeMark">' +
        '<span class="badge__still" id="fb-badgeStill"></span>' +
        // LOCAL (portal integration): the resting mark, when a host gives one. `opts.liveMark`
        // is an animated image - the Data Browser's own bird - and it is what the badge shows
        // when nobody has touched it.
        '<span class="badge__live" id="fb-badgeLive"></span>' +
        '<span class="badge__frames" id="fb-badgeFrames"></span>' +
      '</span>' +
      '<span class="badge__lab"><span class="badge__pow">' + content.badgeEyebrow +
      '</span><span class="badge__name">' + content.badgeName + '</span></span></button>');

    pop = el('<div class="pop" id="fb-pop" hidden><div class="pop__in" role="dialog"' +
      ' aria-modal="true" aria-label="' + content.dialogLabel + '">' +
      '<span class="pop__svg" aria-hidden="true">' + MARK_SVG + '</span>' +
      tileMarkup('docs', 'fb-docsTile', LINKS.docs, content.icons.docs) +
      tileMarkup('api', 'fb-apiTile', LINKS.api, content.icons.api) +
      '<div class="pop__body" id="fb-popBody"><div id="fb-popLines"></div>' +
        '<div class="pop-meta"><span class="pop-meta__label">' + content.orgsLabel + '</span>' +
        '<div class="pop-meta__viewport" aria-label="' + content.orgsAria + '">' +
          '<div class="pop-meta__track" id="fb-orgTrack"></div></div>' +
        '<a class="pop-mail" id="fb-popContact" href="mailto:' + content.email + '">' +
          content.icons.mail +
          '<span class="pop-mail__addr">' + content.email + '</span>' +
          '<span class="pop-mail__go" aria-hidden="true">&rsaquo;</span></a>' +
      '</div></div>' +
      '<button class="pop__close" id="fb-popClose" title="' + content.closeTitle +
      '" aria-label="' + content.closeTitle + '">' +
        '<svg viewBox="778 48 215 202" aria-hidden="true" focusable="false" preserveAspectRatio="none">' +
        '<path class="wedge" d="' + G.wedgePath + '"/></svg>' +
        '<span class="pop__close-ring" aria-hidden="true"></span>' +
        '<span class="pop__close-x" aria-hidden="true"></span></button>' +
      '</div></div>');

    featherCanvas = el('<canvas class="feather-canvas" id="fb-featherCanvas" aria-hidden="true"></canvas>');
    canvas = el('<canvas class="bird-canvas" id="fb-birdCanvas" aria-hidden="true"></canvas>');
    root.appendChild(badge); root.appendChild(pop);
    root.appendChild(featherCanvas); root.appendChild(canvas);
    (mount || document.body).appendChild(root);

    badgeMark = root.querySelector('#fb-badgeMark');
    badgeStill = root.querySelector('#fb-badgeStill');
    badgeLive = root.querySelector('#fb-badgeLive');
    badgeFrames = root.querySelector('#fb-badgeFrames');
    popIn = root.querySelector('.pop__in');
    popBody = root.querySelector('#fb-popBody');
    popLines = root.querySelector('#fb-popLines');
    popClose = root.querySelector('#fb-popClose');
    docsTile = root.querySelector('#fb-docsTile');
    apiTile = root.querySelector('#fb-apiTile');
    popContact = root.querySelector('#fb-popContact');
    featherCtx = null; ctx = null;
    logoTiles = [docsTile, apiTile];
  }
  var logoTiles = [];

  // loose plumage
  // Independent of the bird clock. The two anatomical silhouettes below are rendered
  // procedurally, but their movement behaves like a light object in air: a brief impulse,
  // terminal fall, irregular sculling, rocking, and an edge-on flip rather than constant rotation.
  var feathers = [];
  var featherRunning = false;
  var featherLast = 0;
  var featherRaf = 0;
  var FEATHERS = {
    takeoff: {
      count: 10, size: [5.5, 12.5], speed: [8, 23], direction: -2.05,
      spread: 1.15, scatter: 0.11, release: 0.32, life: [1.9, 3.0],
      terminal: [24, 40], drift: [-7, 4], sway: [6, 14]
    }
  };

  function rand(a, b) { return a + Math.random() * (b - a); }

  function featherTransform(f, edge) {
    featherCtx.translate(f.x, f.y);
    featherCtx.rotate(f.drawAngle);
    featherCtx.scale(f.mirror * edge, 1);
  }

  // An asymmetric contour feather: narrow bare quill, unequal vanes, a soft warm-white body and
  // just enough barb detail to read at UI scale.
  function drawContourFeather(f, edge) {
    var length = f.size;
    var width = length * f.wide;
    var base = length * 0.49;
    var tip = -length * 0.51;
    var bend = width * f.bend;
    featherCtx.save();
    featherTransform(f, edge);
    featherCtx.globalAlpha = f.alpha * (0.62 + edge * 0.38);

    featherCtx.beginPath();
    featherCtx.moveTo(0, base * 0.82);
    featherCtx.bezierCurveTo(
      width * 0.46, base * 0.48,
      width * 1.08 + bend * 0.35, -length * 0.10,
      bend, tip);
    featherCtx.bezierCurveTo(
      -width * 0.75 + bend * 0.40, -length * 0.12,
      -width * 0.54, base * 0.38,
      0, base * 0.82);
    featherCtx.closePath();
    var fill = featherCtx.createLinearGradient(-width, base, width, tip);
    fill.addColorStop(0, f.warm ? 'rgba(218,220,211,.78)' : 'rgba(218,226,232,.76)');
    fill.addColorStop(0.46, 'rgba(250,251,249,.92)');
    fill.addColorStop(1, 'rgba(235,239,239,.78)');
    featherCtx.fillStyle = fill;
    featherCtx.fill();

    featherCtx.strokeStyle = 'rgba(126,136,140,.42)';
    featherCtx.lineWidth = Math.max(0.34, length * 0.022);
    featherCtx.beginPath();
    featherCtx.moveTo(-bend * 0.08, base);
    featherCtx.quadraticCurveTo(bend * 0.35, 0, bend, tip);
    featherCtx.stroke();

    if (length > 8.5 && edge > 0.25) {
      featherCtx.strokeStyle = 'rgba(145,153,154,.23)';
      featherCtx.lineWidth = Math.max(0.24, length * 0.011);
      featherCtx.beginPath();
      for (var i = 1; i <= 5; i++) {
        var t = i / 6;
        var y = base * 0.55 + (tip - base * 0.55) * t;
        var mid = bend * t * t;
        var envelope = Math.sin(Math.PI * Math.pow(t, 0.72));
        var right = width * envelope * (0.82 + 0.08 * Math.sin(f.seed + i));
        var left = width * envelope * (0.59 + 0.07 * Math.cos(f.seed + i));
        featherCtx.moveTo(mid, y);
        featherCtx.quadraticCurveTo(mid + right * 0.62, y + length * 0.025,
          mid + right, y + length * 0.055);
        featherCtx.moveTo(mid, y);
        featherCtx.quadraticCurveTo(mid - left * 0.60, y + length * 0.022,
          mid - left, y + length * 0.050);
      }
      featherCtx.stroke();
    }
    featherCtx.restore();
  }

  // A down tuft is mostly separate soft filaments instead of a filled petal.
  function drawDownFeather(f, edge) {
    var length = f.size;
    featherCtx.save();
    featherTransform(f, 0.68 + edge * 0.32);
    featherCtx.globalAlpha = f.alpha * 0.78;
    featherCtx.lineCap = 'round';
    featherCtx.strokeStyle = 'rgba(246,248,245,.78)';
    featherCtx.lineWidth = Math.max(0.34, length * 0.055);
    featherCtx.beginPath();
    for (var i = 0; i < 7; i++) {
      var phase = f.seed + i * 2.17;
      var side = Math.sin(phase);
      var reach = length * (0.38 + 0.14 * Math.cos(phase * 1.31));
      featherCtx.moveTo(0, length * 0.30);
      featherCtx.bezierCurveTo(
        side * length * 0.16, length * 0.08,
        side * length * 0.29, -reach * 0.45,
        side * length * 0.36, -reach);
    }
    featherCtx.stroke();
    featherCtx.strokeStyle = 'rgba(154,159,154,.42)';
    featherCtx.lineWidth = Math.max(0.28, length * 0.035);
    featherCtx.beginPath();
    featherCtx.moveTo(0, length * 0.47);
    featherCtx.quadraticCurveTo(length * 0.025, 0, -length * 0.02, -length * 0.27);
    featherCtx.stroke();
    featherCtx.restore();
  }

  function drawFeather(f) {
    var edge = 0.14 + 0.86 * Math.abs(Math.cos(f.flip));
    if (f.kind === 'down') drawDownFeather(f, edge);
    else drawContourFeather(f, edge);
  }

  function emitFeathers(point, spec) {
    if (calm.matches || !point) return;
    resizeFeatherCanvas();
    var scatter = (point.r || 40) * spec.scatter;
    for (var i = 0; i < spec.count; i++) {
      var direction = spec.direction + rand(-spec.spread * 0.5, spec.spread * 0.5);
      var speed = rand(spec.speed[0], spec.speed[1]);
      var seedAngle = rand(0, Math.PI * 2);
      var seedRadius = Math.sqrt(Math.random()) * scatter;
      var kind = Math.random() < 0.30 ? 'down' : 'contour';
      feathers.push({
        x: point.x + Math.cos(seedAngle) * seedRadius,
        y: point.y + Math.sin(seedAngle) * seedRadius * 0.62,
        vx: Math.cos(direction) * speed,
        vy: Math.sin(direction) * speed,
        drift: rand(spec.drift[0], spec.drift[1]),
        terminal: rand(spec.terminal[0], spec.terminal[1]),
        verticalRate: rand(1.55, 2.35),
        horizontalRate: rand(1.0, 1.75),
        sway: rand(spec.sway[0], spec.sway[1]),
        phase: rand(0, Math.PI * 2),
        flutterRate: rand(1.9, 3.45),
        secondaryPhase: rand(0, Math.PI * 2),
        baseAngle: rand(-Math.PI, Math.PI),
        turn: rand(-0.18, 0.18),
        rock: rand(0.24, 0.56),
        flip: rand(0, Math.PI * 2),
        flipRate: rand(1.25, 2.55) * (Math.random() < 0.5 ? -1 : 1),
        mirror: Math.random() < 0.5 ? -1 : 1,
        kind: kind,
        size: rand(spec.size[0], spec.size[1]) * (kind === 'down' ? 0.86 : 1),
        wide: rand(0.17, 0.23),
        bend: rand(-0.62, 0.62),
        warm: Math.random() < 0.22,
        seed: rand(0, 100),
        life: rand(spec.life[0], spec.life[1]),
        age: -rand(0, spec.release),
        alpha: 0,
        drawAngle: 0
      });
    }
    if (feathers.length > 42) feathers.splice(0, feathers.length - 42);
    featherCanvas.style.display = 'block';
    if (!featherRunning) {
      featherRunning = true;
      featherLast = performance.now();
      requestAnimationFrame(stepFeathers);
    }
  }

  function stepFeathers(now) {
    var dt = Math.min(0.033, Math.max(0.001, (now - featherLast) / 1000));
    featherLast = now;
    resizeFeatherCanvas();
    clearFeatherSurface();
    var width = window.innerWidth, height = window.innerHeight;
    for (var i = 0; i < feathers.length; i++) {
      var f = feathers[i];
      f.age += dt;
      if (f.age < 0 || f.age >= f.life) continue;
      f.phase += f.flutterRate * dt;
      f.flip += f.flipRate * dt;
      var scull = Math.sin(f.phase) * f.sway +
        Math.sin(f.phase * 0.47 + f.secondaryPhase) * f.sway * 0.31;
      var targetX = f.drift + scull;
      f.vx += (targetX - f.vx) * (1 - Math.exp(-f.horizontalRate * dt));
      f.vy += (f.terminal - f.vy) * (1 - Math.exp(-f.verticalRate * dt));
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.baseAngle += f.turn * dt;
      f.drawAngle = f.baseAngle + Math.sin(f.phase + 0.55) * f.rock +
        Math.atan2(f.vy, Math.max(1, Math.abs(f.vx))) * 0.07;

      var progress = f.age / f.life;
      var fade = 1;
      if (progress > 0.68) {
        var q = Math.min(1, (progress - 0.68) / 0.32);
        fade = 1 - q * q * (3 - 2 * q);
      }
      f.alpha = Math.min(1, f.age / 0.10) * fade * 0.82;
      if (f.x > -30 && f.x < width + 30 && f.y > -40 && f.y < height + 45) {
        drawFeather(f);
      }
    }
    feathers = feathers.filter(function (f) {
      return f.age < f.life && f.x > -80 && f.x < width + 80 && f.y < height + 90;
    });
    if (feathers.length && !document.hidden) {
      featherRaf = requestAnimationFrame(stepFeathers);
      return;
    }
    feathers.length = 0;
    featherRaf = 0;
    featherRunning = false;
    featherCanvas.style.display = 'none';
    clearFeatherSurface();
  }

  function popBox() { return pop.getBoundingClientRect(); }

  function rimY(viewBoxX) {
    var rim = G.rim;
    if (viewBoxX <= rim[0][0]) return rim[0][1];
    for (var i = 1; i < rim.length; i++) {
      if (rim[i][0] >= viewBoxX) {
        var a = rim[i - 1], b = rim[i];
        var part = (viewBoxX - a[0]) / Math.max(0.0001, b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * part;
      }
    }
    return rim[rim.length - 1][1];
  }

  function rimPoint(ratio) {
    var box = popBox();
    var units = box.width / G.vb[0];
    var vx = ratio * G.vb[0];
    return { x: box.left + vx * units, y: box.top + rimY(vx) * units + 1 };
  }

  function rimScreenY(screenX) {
    var box = popBox();
    var units = box.width / G.vb[0];
    var vx = (screenX - box.left) / Math.max(0.0001, units);
    return box.top + rimY(vx) * units + 1;
  }

  // Least-squares slope of the rim across a short span centred on a screen x. A single-segment
  // difference inherits the polyline's quantisation and makes the bird flicker; a fit over ~40
  // viewBox units does not.
  function rimSlope(screenX) {
    var box = popBox();
    var units = box.width / G.vb[0];
    var vx = (screenX - box.left) / Math.max(0.0001, units);
    var span = G.tilt.spanVb, steps = 4;
    var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = -steps; i <= steps; i++) {
      var x = vx + span * i / steps, y = rimY(x);
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var den = n * sxx - sx * sx;
    return den === 0 ? 0 : (n * sxy - sx * sy) / den;
  }

  function perchTilt(screenX) {
    var limit = G.tilt.maxDeg * Math.PI / 180;
    var a = Math.atan(rimSlope(screenX)) * G.tilt.factor;
    return Math.max(-limit, Math.min(limit, a));
  }

  function badgePoint() {
    var r = badgeMark.getBoundingClientRect();
    return {
      x: r.left + G.badgeMark.cx * r.width,
      y: r.top + G.badgeMark.cy * r.height,
      r: r.width
    };
  }

  function smooth(t) { return t * t * (3 - 2 * t); }
  function bezier(a, b, c, d, t) {
    var q = 1 - t;
    return q * q * q * a + 3 * q * q * t * b + 3 * q * t * t * c + t * t * t * d;
  }

  function flightPoint(start, end, t) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var p1 = { x: start.x + dx * 0.20, y: start.y + dy * 0.46 };
    var p2 = { x: end.x - dx * 0.28, y: end.y - dy * 0.10 };
    var u = smooth(t);
    return {
      x: bezier(start.x, p1.x, p2.x, end.x, u),
      y: bezier(start.y, p1.y, p2.y, end.y, u)
    };
  }


  // on-demand motion assets
  // Nothing here runs until someone shows intent. Manifests are small JSON; the sprite sheets are
  // WebP chunks, so a chunk is decoded when it is needed and dropped when it is not. Every load is
  // tokenised: a panel closed while a chunk is in flight discards it rather than holding on to a
  // decoded sheet nobody will draw.
  var MOTION = { bridge: null, ground: null, still: null };
  var SHEETS = { bridge: {}, ground: {} };
  var PENDING = { bridge: {}, ground: {} };
  var assetToken = 0;
  var manifestPromise = {};

  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.decoding = 'async';
      image.onload = function () {
        if (image.decode) { image.decode().then(function () { resolve(image); }, function () { resolve(image); }); }
        else resolve(image);
      };
      image.onerror = function () { reject(new Error(src)); };
      image.src = src;
    });
  }

  function manifest(kind) {
    var key = kind + '@' + scaleKey();
    if (!manifestPromise[key]) {
      manifestPromise[key] = fetchJSON(BASE + 'motion/' + key + '.json')
        .then(function (m) { MOTION[kind] = m; return m; });
    }
    return manifestPromise[key];
  }

  function chunk(kind, index) {
    var have = SHEETS[kind][index];
    if (have) return Promise.resolve(have);
    if (PENDING[kind][index]) return PENDING[kind][index];
    var man = MOTION[kind];
    var token = assetToken;
    var p = loadImage(BASE + 'motion/' + man.chunks[index].f).then(function (img) {
      delete PENDING[kind][index];
      if (token !== assetToken) return null;      // closed while in flight
      SHEETS[kind][index] = img;
      return img;
    }, function (e) { delete PENDING[kind][index]; throw e; });
    PENDING[kind][index] = p;
    return p;
  }

  function releaseChunk(kind, index) {
    var img = SHEETS[kind][index];
    if (!img) return;
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAI=';
    delete SHEETS[kind][index];
  }

  function releaseAll() {
    assetToken++;
    ['bridge', 'ground'].forEach(function (kind) {
      Object.keys(SHEETS[kind]).forEach(function (i) { releaseChunk(kind, i); });
      PENDING[kind] = {};
    });
  }

  function chunkOf(man, src) {
    var r = man.rect[src];
    return r ? r[0] : 0;
  }

  // Ground has to be complete before the handoff, seven seconds after the panel opens; bridge
  // chunks are consumed once and then dropped.
  function loadGroundAhead() {
    return manifest('ground').then(function (man) {
      return man.chunks.reduce(function (p, _c, i) {
        return p.then(function () { return chunk('ground', i); });
      }, Promise.resolve());
    });
  }

  function loadBridgeFrom(index) {
    var man = MOTION.bridge;
    if (!man) return Promise.resolve();
    var next = Math.min(index + 1, man.chunks.length - 1);
    return chunk('bridge', index).then(function () {
      if (next !== index) chunk('bridge', next).catch(function () {});
    });
  }

  // drawing surfaces
  // Two full-viewport canvases at DPR 2 would cost 39.6 MiB. These are sized to the box the bird
  // and its plumage can actually reach, and their backing stores are dropped when the panel
  // closes.
  var region = null;
  var dpr = 1;
  var featherDpr = 1;
  var regionStale = true;
  var fittedRegion = null;
  var fittedFeatherRegion = null;

  function computeRegion() {
    var b = pop.getBoundingClientRect();
    var m = badgeMark.getBoundingClientRect();
    var pad = 96;                                  // drift + drop shadow
    var left = Math.max(0, Math.min(b.left, m.left) - pad);
    var top = Math.max(0, Math.min(b.top, m.top) - pad);
    var right = Math.min(window.innerWidth, Math.max(b.right, m.right) + pad);
    var bottom = Math.min(window.innerHeight, Math.max(b.bottom, m.bottom) + pad);
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
  }

  // Neither box moves while the panel is open, so the region is measured when something can move
  // it and cached in between, rather than read on every frame.
  function currentRegion() {
    if (regionStale || !region) { region = computeRegion(); regionStale = false; }
    return region;
  }

  function fitSurface(el, ctxRef, r, ratio) {
    var pw = Math.round(r.w * ratio), ph = Math.round(r.h * ratio);
    if (el.width !== pw) el.width = pw;
    if (el.height !== ph) el.height = ph;
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
    el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
    // Everything downstream thinks in viewport coordinates; the region offset lives in the
    // transform rather than in the placement maths.
    ctxRef.setTransform(ratio, 0, 0, ratio, -r.x * ratio, -r.y * ratio);
    ctxRef.imageSmoothingEnabled = true;
    ctxRef.imageSmoothingQuality = 'high';
  }

  function surfaceRatio() {
    return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  }

  function resizeCanvas() {
    if (!ctx) ctx = canvas.getContext('2d', { alpha: true });
    var ratio = surfaceRatio();
    var r = currentRegion();
    if (r === fittedRegion && ratio === dpr) return;
    dpr = ratio;
    fittedRegion = r;
    fitSurface(canvas, ctx, r, dpr);
  }

  function resizeFeatherCanvas() {
    if (!featherCtx) featherCtx = featherCanvas.getContext('2d', { alpha: true });
    var ratio = surfaceRatio();
    var r = currentRegion();
    if (r === fittedFeatherRegion && ratio === featherDpr) return;
    featherDpr = ratio;
    fittedFeatherRegion = r;
    fitSurface(featherCanvas, featherCtx, r, featherDpr);
  }

  function clearBird() {
    if (!ctx || !region) return;
    ctx.clearRect(region.x, region.y, region.w, region.h);
  }

  function clearFeatherSurface() {
    if (!featherCtx) return;
    var r = currentRegion();
    featherCtx.clearRect(r.x, r.y, r.w, r.h);
  }

  function releaseSurfaces() {
    [[canvas, 'ctx'], [featherCanvas, 'featherCtx']].forEach(function (pair) {
      var el = pair[0];
      el.style.display = 'none';
      el.width = 0; el.height = 0;          // frees the backing store
      el.style.width = '0px'; el.style.height = '0px';
    });
    ctx = null; featherCtx = null; region = null;
    regionStale = true; fittedRegion = null; fittedFeatherRegion = null;
  }

  // one frame
  // Each sprite is stored cropped to its own alpha box; `ox, oy, tw, th` put it back exactly where
  // it sat in the master cell.
  function drawSprite(man, index, offset, scale, tilt, pivot) {
    if (!man || !ctx) return false;
    index = Math.max(0, Math.min(man.count - 1, index));
    var src = man.src ? man.src[index] : index;
    var rect = man.rect[src];
    if (!rect) return false;
    var sheet = SHEETS[man.kind][rect[0]];
    if (!sheet) { chunk(man.kind, rect[0]).catch(function () {}); return false; }
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    if (tilt && pivot) {
      ctx.translate(pivot[0], pivot[1]);
      ctx.rotate(tilt);
      ctx.translate(-pivot[0], -pivot[1]);
    }
    ctx.drawImage(sheet, rect[1], rect[2], rect[3], rect[4], rect[5], rect[6], rect[7], rect[8]);
    ctx.restore();
    return true;
  }

  function motionLayout() {
    var BRIDGE = MOTION.bridge, GROUND = MOTION.ground;
    var box = popBox();
    var desiredStandingHeight = Math.min(
      GROUND.display.desiredHeightPx, box.width * 0.21) * MOVING_BIRD_SCALE;
    var bridgeScale = desiredStandingHeight / BRIDGE.lastBBoxH;
    var groundScale = bridgeScale;
    var targetFoot = rimPoint(GROUND.display.baseRatio);
    var sharedFoot = { x: targetFoot.x, y: targetFoot.y + GROUND.display.toeInsetPx };
    var start = badgePoint();
    var startOffset = {
      x: start.x - BRIDGE.firstCentroid[0] * bridgeScale,
      y: start.y - BRIDGE.firstCentroid[1] * bridgeScale
    };
    var bridgeOffset = {
      x: sharedFoot.x - BRIDGE.finalContact[0] * bridgeScale,
      y: sharedFoot.y - BRIDGE.finalContact[1] * bridgeScale
    };
    var airborneSeconds = BRIDGE.timing.airborneSeconds;
    var landingSeconds = (BRIDGE.count - BRIDGE.timing.landingFirstFrame) /
      BRIDGE.timing.landingFps;
    return {
      bridgeScale: bridgeScale,
      groundScale: groundScale,
      perchTilt: perchTilt(targetFoot.x),
      airborneSeconds: airborneSeconds,
      bridgeSeconds: airborneSeconds + landingSeconds,
      startOffset: startOffset,
      bridgeOffset: bridgeOffset
    };
  }

  function groundOffset(layout, index) {
    var GROUND = MOTION.ground;
    var base = rimPoint(GROUND.display.baseRatio);
    var worldX = base.x + GROUND.curveX[index] * layout.groundScale;
    return {
      x: base.x + GROUND.drawX[index] * layout.groundScale,
      y: rimScreenY(worldX) + GROUND.display.toeInsetPx -
        GROUND.groundY * layout.groundScale
    };
  }

  // The signature is every input the next drawImage would use. Identical signature, identical
  // pixels - so the paint is skipped. In the walk that caps painting at the source's 24 fps; in
  // flight the position is a continuous function of time, so it changes and is drawn every frame.
  // Capping the flight would visibly step it.
  var lastSignature = '';

  function paintMotion(elapsedSeconds, force) {
    var BRIDGE = MOTION.bridge, GROUND = MOTION.ground;
    if (!BRIDGE) return;
    var layout = motionLayout();
    elapsedSeconds = Math.max(0, elapsedSeconds);
    var phase, index, offset, scale, tilt, pivot, man;

    if (elapsedSeconds < layout.airborneSeconds) {
      phase = 'air'; man = BRIDGE;
      index = Math.min(BRIDGE.timing.airborneLastFrame,
        Math.floor(elapsedSeconds / Math.max(0.001, layout.airborneSeconds) *
          (BRIDGE.timing.airborneLastFrame + 1)));
      offset = flightPoint(layout.startOffset, layout.bridgeOffset,
        elapsedSeconds / Math.max(0.001, layout.airborneSeconds));
      var lean = Math.max(0, Math.min(1,
        (elapsedSeconds / Math.max(0.001, layout.airborneSeconds) - 0.7) / 0.3));
      scale = layout.bridgeScale; tilt = layout.perchTilt * smooth(lean);
      pivot = BRIDGE.finalContact;
    } else if (elapsedSeconds < layout.bridgeSeconds) {
      phase = 'land'; man = BRIDGE;
      index = Math.min(BRIDGE.count - 1,
        BRIDGE.timing.landingFirstFrame + Math.floor(
          (elapsedSeconds - layout.airborneSeconds) * BRIDGE.timing.landingFps));
      offset = layout.bridgeOffset; scale = layout.bridgeScale;
      tilt = layout.perchTilt; pivot = BRIDGE.finalContact;
    } else {
      if (!GROUND) return;
      phase = 'ground'; man = GROUND;
      var groundElapsed = elapsedSeconds - layout.bridgeSeconds;
      index = (GROUND_START_FRAME + Math.floor(groundElapsed * GROUND.fps)) % GROUND.count;
      offset = groundOffset(layout, index);
      scale = layout.groundScale;
      var contactScreenX = rimPoint(GROUND.display.baseRatio).x +
        GROUND.curveX[index] * layout.groundScale;
      tilt = perchTilt(contactScreenX);
      pivot = [GROUND.contactX[index], GROUND.groundY];
    }

    var sig = phase + '|' + index + '|' + offset.x.toFixed(2) + '|' + offset.y.toFixed(2) +
      '|' + scale.toFixed(4) + '|' + tilt.toFixed(4);
    if (!force && sig === lastSignature) return;
    clearBird();
    if (drawSprite(man, index, offset, scale, tilt, pivot)) lastSignature = sig;

    // the flight is over: the bridge sheets will not be looked at again
    if (phase === 'ground' && bridgeLive) { bridgeLive = false; releaseBridge(); }
  }

  var bridgeLive = false;
  function releaseBridge() {
    Object.keys(SHEETS.bridge).forEach(function (i) { releaseChunk('bridge', i); });
  }

  // the loop
  // One rAF chain, one token. Closing cancels it; hiding the document parks it and remembers where
  // it was, so coming back resumes rather than jumps.
  var birdRaf = 0;
  var birdStarted = 0;
  var birdParked = null;

  function runBird(token) {
    if (!isOpen || token !== birdToken) { birdRaf = 0; return; }
    if (document.hidden) { birdParked = (performance.now() - birdStarted) / 1000; birdRaf = 0; return; }
    resizeCanvas();
    paintMotion((performance.now() - birdStarted) / 1000);
    birdRaf = requestAnimationFrame(function () { runBird(token); });
  }

  function stopBird() {
    if (birdRaf) cancelAnimationFrame(birdRaf);
    birdRaf = 0; birdParked = null; lastSignature = '';
  }

  function paintStill() {
    var s = MOTION.still;
    if (!s || !ctx) return;
    var box = popBox();
    var scale = Math.min(s.display.desiredHeightPx, box.width * 0.21) *
      MOVING_BIRD_SCALE / s.lastBBoxH;
    var base = rimPoint(s.display.baseRatio);
    var worldX = base.x + s.curveX * scale;
    var offset = { x: base.x + s.drawX * scale,
                   y: rimScreenY(worldX) + s.display.toeInsetPx - s.groundY * scale };
    clearBird();
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    var tilt = perchTilt(base.x + s.curveX * scale);
    if (tilt) { ctx.translate(s.contactX, s.groundY); ctx.rotate(tilt);
                ctx.translate(-s.contactX, -s.groundY); }
    ctx.drawImage(s.image, 0, 0, s.w, s.h, s.ox, s.oy, s.tw, s.th);
    ctx.restore();
  }

  function startStill(token) {
    var key = scaleKey();
    return fetchJSON(BASE + 'motion/still@' + key + '.json').then(function (s) {
      return loadImage(BASE + 'motion/still@' + key + '.webp').then(function (img) {
        if (!isOpen || token !== birdToken) return;
        s.image = img;
        s.lastBBoxH = s.baseBBoxH;
        MOTION.still = s;
        canvas.style.display = 'block';
        resizeCanvas();
        paintStill();
      });
    });
  }

  function startBird(token) {
    if (wantsStill()) return startStill(token).catch(function () { canvas.style.display = 'none'; });
    return manifest('bridge').then(function (man) {
      bridgeLive = true;
      loadGroundAhead().catch(function () {});
      return chunk('bridge', 0).then(function () { return man; });
    }).then(function () {
      if (!isOpen || token !== birdToken) return;
      canvas.style.display = 'block';
      resizeCanvas();
      // the rest of the flight, in order, while the first chunk is playing
      (MOTION.bridge.chunks || []).forEach(function (_c, i) {
        if (i) chunk('bridge', i).catch(function () {});
      });
      birdStarted = performance.now();
      birdParked = null;
      paintMotion(0, true);
      birdRaf = requestAnimationFrame(function () { runBird(token); });
    }).catch(function () { canvas.style.display = 'none'; });
  }

  function placeLogoTile(tile, geometry, units) {
    tile.style.left = geometry[0] * units + 'px';
    tile.style.top = geometry[1] * units + 'px';
    tile.style.width = geometry[2] * units + 'px';
    tile.style.height = geometry[3] * units + 'px';
  }

  function layoutPopup() {
    var box = popBox();
    var units = box.width / G.vb[0];
    var text = G.text, amber = G.amber;
    popBody.style.left = text[0] * units + 'px';
    popBody.style.top = text[1] * units + 'px';
    popBody.style.width = text[2] * units + 'px';
    popBody.style.height = text[3] * units + 'px';
    popClose.style.left = amber[0] * units + 'px';
    popClose.style.top = amber[1] * units + 'px';
    popClose.style.width = amber[2] * units + 'px';
    popClose.style.height = amber[3] * units + 'px';
    placeLogoTile(docsTile, TILE_GEOMETRY.docs, units);
    placeLogoTile(apiTile, TILE_GEOMETRY.api, units);
  }

  // the footer story
  // The badge paints its static mark from the last story frame, a few kilobytes. The 260-frame
  // sheet is a separate, much larger asset, fetched only when the browser is idle - never during
  // first paint, never for reduced-motion or Save-Data. The real production sheet is not in this
  // archive; it drops in here and nothing else changes.
  var STORY = null;
  var storyToken = 0;
  var storyIndex = -1;
  var storySheetReady = false;
  var storyWanted = false;
  var storySize = null;
  var storySized = null;

  // The mark box is the same size for every frame: measured once per run, and only the offset
  // moves per frame.
  function storyBox() {
    if (!storySize) {
      var r = badgeFrames.getBoundingClientRect();
      storySize = { w: r.width || 158, h: r.height || 63 };
    }
    return storySize;
  }

  function storyFrame(index) {
    if (!STORY || index === storyIndex) return;
    storyIndex = index;
    var box = storyBox();
    if (box !== storySized) {
      badgeFrames.style.backgroundSize = box.w * STORY.cols + 'px ' + box.h * STORY.rows + 'px';
      storySized = box;
    }
    badgeFrames.style.backgroundPosition =
      -(index % STORY.cols) * box.w + 'px ' + -Math.floor(index / STORY.cols) * box.h + 'px';
  }

  function playStory() {
    if (!storySheetReady) { storyWanted = true; return; }
    var token = ++storyToken;
    storyIndex = -1;
    storySize = null;
    // LOCAL (portal integration): a reduced-motion visitor is not shown the story at all - the
    // resting mark is the whole of it for them.
    if (calm.matches) { restMark(); return; }
    tellingMark();
    var started = performance.now();
    (function step(now) {
      if (token !== storyToken) return;
      if (document.hidden) { restMark(); return; }
      var index = Math.min(STORY.count - 1, Math.floor((now - started) * STORY.fps / 1000));
      storyFrame(index);
      if (index < STORY.count - 1) { requestAnimationFrame(step); return; }
      // LOCAL (portal integration): the bird has landed. Hand the mark back to the resting
      // state, which is where it lives between stories.
      restMark();
    })(started);
  }

  // which mark is showing
  // LOCAL (portal integration). Three layers, one visible at a time:
  //
  //   live    the host's animated mark - the resting state, when there is one
  //   still   the package's own static mark - the resting state otherwise, and the only one a
  //           reduced-motion visitor ever sees
  //   frames  the story sheet, while the story is actually running
  //
  // The story is a state, not a destination: the sheet is shown while the story runs and put away
  // afterwards, so the mark goes back to living once the story has finished telling itself.
  var hasLive = false;

  function restMark() {
    badgeFrames.classList.remove('is-ready');
    badgeFrames.style.display = 'none';
    badgeLive.style.display = hasLive ? 'block' : 'none';
    badgeStill.style.display = hasLive ? 'none' : 'block';
  }

  function tellingMark() {
    badgeFrames.style.display = 'block';
    badgeFrames.classList.add('is-ready');
    badgeLive.style.display = 'none';
    badgeStill.style.display = 'none';
  }

  function loadStory() {
    if (storySheetReady || wantsStill()) return Promise.resolve();
    // LOCAL (portal integration): the sheet is loaded straight from its own same-origin URL
    // rather than fetched as bytes behind an object URL. A host with an ordinary
    // `img-src 'self' data:` refuses a `blob:` URL, which leaves the sheet never ready and the
    // badge on its static mark for good; widening a portal's policy for a background image is the
    // wrong trade. It is one request either way.
    return fetchJSON(BASE + 'story.json').then(function (s) {
      STORY = s;
      return loadImage(BASE + 'story@2x.webp');
    }).then(function (img) {
      STORY.rows = Math.ceil(STORY.count / STORY.cols);
      badgeFrames.style.backgroundImage = 'url(' + img.src + ')';
      storySheetReady = true;
      // LOCAL (portal integration): arriving changes nothing on screen. The sheet is shown
      // while the story runs and put away afterwards, so the mark a visitor is looking at does
      // not swap under them on a fetch.
      // LOCAL (portal integration): the sheet plays only if something asked for it while it
      // was still loading, so a page load never starts unprompted motion in the corner of a
      // documentation page. The story belongs to the interaction: `closePopup` asks for it, and
      // swapping the still for the sheet's last frame is invisible because the still *is* that
      // frame.
      if (storyWanted) { storyWanted = false; playStory(); }
    }).catch(function () { /* the static mark stays; nothing else breaks */ });
  }

  function markAway(away) {
    badge.classList.toggle('badge--away', away);
    if (away) storyToken++;
  }

  function buildOrgs() {
    var track = root.querySelector('#fb-orgTrack');
    if (!track) return;
    track.textContent = '';
    [0, 1].forEach(function (copy) {
      var group = document.createElement('div');
      group.className = 'pop-meta__group';
      if (copy) group.setAttribute('aria-hidden', 'true');
      ORGS.forEach(function (org) {
        // LOCAL (portal integration): a chip is a link when the organisation has a home, a
        // plain span when it does not. The duplicate group that makes the marquee seamless is
        // `aria-hidden`, so its chips are never links - a screen reader would otherwise read
        // every institution twice and offer twelve unreachable duplicates in the tab order.
        var linked = Boolean(org.href) && !copy;
        var chip = document.createElement(linked ? 'a' : 'span');
        chip.className = 'org';
        if (linked) {
          chip.href = org.href;
          chip.target = '_blank';
          chip.rel = 'noopener noreferrer';
        }
        var mark = document.createElement('span');
        mark.className = 'org__mark';
        if (org.logo) {
          var img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = function () {
            if (img.parentNode) img.parentNode.removeChild(img);
            mark.classList.add('org__mark--empty');
          };
          img.src = /^(?:[a-z]+:)?\/\//.test(org.logo) ? org.logo : BASE + org.logo;
          mark.appendChild(img);
        } else {
          mark.className += ' org__mark--empty';
        }
        var name = document.createElement('span');
        name.className = 'org__name';
        name.textContent = org.name;
        chip.appendChild(mark); chip.appendChild(name);
        group.appendChild(chip);
      });
      track.appendChild(group);
    });
  }

  function layPanel() {
    popLines.textContent = '';
    var kicker = document.createElement('span');
    kicker.className = 'pop__kicker';
    var head = document.createElement('h2');
    head.className = 'pop__head';
    var lines = COPY.head.map(function () {
      var b = document.createElement('b');
      head.appendChild(b);
      return b;
    });
    var sub = document.createElement('p');
    sub.className = 'pop__sub';
    sub.textContent = COPY.sub;
    popLines.appendChild(kicker);
    popLines.appendChild(head);
    popLines.appendChild(sub);
    return { kicker: kicker, lines: lines };
  }

  // The marked word only goes in once its line has finished typing - typing through a nested
  // element would mean rebuilding the markup every character.
  function settleLine(node, line) {
    if (!line.mark || line.text.indexOf(line.mark) < 0) { node.textContent = line.text; return; }
    var at = line.text.indexOf(line.mark);
    node.textContent = '';
    node.appendChild(document.createTextNode(line.text.slice(0, at)));
    var em = document.createElement('em');
    em.textContent = line.mark;
    node.appendChild(em);
    node.appendChild(document.createTextNode(line.text.slice(at + line.mark.length)));
  }

  function tellRest() { popBody.classList.add('is-told'); }

  function typeAll(delay) {
    var token = ++typing;
    var parts = layPanel();
    if (calm.matches) {
      parts.kicker.textContent = COPY.kicker;
      COPY.head.forEach(function (line, i) { settleLine(parts.lines[i], line); });
      tellRest();
      return;
    }
    var caret = document.createElement('span');
    caret.className = 'caret';
    var queue = [{ node: parts.kicker, text: COPY.kicker, pace: 52, rest: 300 }];
    COPY.head.forEach(function (line, i) {
      queue.push({ node: parts.lines[i], text: line.text, line: line, pace: 30, rest: 150 });
    });
    var at = 0;
    function nextLine() {
      if (token !== typing) return;
      if (at >= queue.length) {
        if (caret.parentNode) caret.remove();
        tellRest();
        return;
      }
      var item = queue[at++], charIndex = 0;
      (function nextCharacter() {
        if (token !== typing) return;
        if (charIndex <= item.text.length) {
          item.node.textContent = item.text.slice(0, charIndex++);
          item.node.appendChild(caret);
          setTimeout(nextCharacter, item.pace);
        } else {
          if (item.line) settleLine(item.node, item.line);
          else item.node.textContent = item.text;
          setTimeout(nextLine, item.rest);
        }
      })();
    }
    setTimeout(nextLine, delay || 0);
  }

  function finishTyping() {
    typing++;
    var parts = layPanel();
    parts.kicker.textContent = COPY.kicker;
    COPY.head.forEach(function (line, i) { settleLine(parts.lines[i], line); });
    tellRest();
  }

  function resetLogoTiles() {
    logoTiles.forEach(function (tile) {
      tile.classList.remove('is-flipped');
      tile.setAttribute('aria-expanded', 'false');
    });
  }


  function onLogoTile(event) {
    // With a pointer the face is already turned by the time anyone clicks, so the click is the
    // click. Touch has no hover: turn it first, open second.
    if (canHover.matches) return;
    var tile = event.currentTarget;
    if (tile.classList.contains('is-flipped')) return;
    event.preventDefault();
    logoTiles.forEach(function (other) {
      var active = other === tile;
      other.classList.toggle('is-flipped', active);
      other.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
  }

  // open / close
  // Opening starts the work and closing ends it: the rAF chain is cancelled, the surfaces give
  // their memory back, and any sheet still in flight is discarded rather than kept.
  var isOpen = false;
  var birdToken = 0;
  var typing = 0;
  var releaseTimer = 0;

  // Anything that can move the badge lands here. Still mode has no loop to repaint with and
  // refitting a canvas clears it, so the still bird is drawn again rather than lost.
  function refit() {
    regionStale = true;
    storySize = null;
    if (!isOpen) return;
    layoutPopup();
    resizeCanvas();
    if (wantsStill()) paintStill();
  }

  function openPopup() {
    if (isOpen) return;
    isOpen = true;
    regionStale = true;
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
    prime();
    pop.hidden = false;
    layoutPopup();
    resetLogoTiles();
    popBody.classList.remove('is-told');
    markAway(true);
    badge.setAttribute('aria-expanded', 'true');
    typeAll(calm.matches ? 0 : 300);
    var token = ++birdToken;
    requestAnimationFrame(function () {
      if (!isOpen || token !== birdToken) return;
      pop.classList.add('is-open');
      emitFeathers(badgePoint(), FEATHERS.takeoff);
      startBird(token);
    });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    popClose.focus({ preventScroll: true });
  }

  function closePopup() {
    if (!isOpen) return;
    isOpen = false;
    birdToken++;
    typing++;
    stopBird();
    pop.classList.remove('is-open');
    setTimeout(function () { if (!isOpen) pop.hidden = true; }, 600);
    canvas.style.display = 'none';
    clearBird();
    badge.setAttribute('aria-expanded', 'false');
    markAway(false);
    playStory();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    badge.focus({ preventScroll: true });
    // The plumage outlives the panel by design, so the surfaces are handed back once the last
    // feather has landed rather than mid-fall.
    releaseTimer = setTimeout(function () {
      releaseTimer = 0;
      if (isOpen || feathers.length) return;
      releaseSurfaces();
      releaseAll();
    }, 3200);
  }

  function onVisibility() {
    if (document.hidden) {
      if (birdRaf) { cancelAnimationFrame(birdRaf); birdRaf = 0; }
      if (isOpen) birdParked = (performance.now() - birdStarted) / 1000;
      return;
    }
    if (isOpen && !birdRaf && !wantsStill() && birdParked !== null) {
      regionStale = true;
      birdStarted = performance.now() - birdParked * 1000;
      birdParked = null;
      var token = birdToken;
      birdRaf = requestAnimationFrame(function () { runBird(token); });
    }
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closePopup(); }
    else if (event.key === 'Tab') {
      event.preventDefault();
      var controls = [docsTile, apiTile, popContact, popClose];
      var index = controls.indexOf(document.activeElement);
      if (index < 0) index = event.shiftKey ? 0 : -1;
      index = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[index].focus();
    }
  }

  function onOutside(event) {
    if (!pop.contains(event.target) && !badge.contains(event.target)) closePopup();
  }


  // intent
  // Pointer over the badge, keyboard focus on it, or a touch that has not yet become a tap. Any of
  // those is enough to start fetching; a page that is never touched fetches nothing beyond the
  // mark.
  var primed = false;
  function prime() {
    if (primed) return Promise.resolve();
    primed = true;
    // LOCAL (portal integration): the footer story sheet is fetched here, with the motion,
    // rather than on an idle callback after first paint. It is 765 kB for a 158x63 mark, and a
    // visitor who never goes near the badge has no use for it - the static mark is the same
    // artwork. See the tail of `loadStory` for the other half: arriving does not mean playing.
    var story = loadStory();
    if (wantsStill()) {
      return Promise.all([
        story,
        fetchJSON(BASE + 'motion/still@' + scaleKey() + '.json')
      ]).catch(function () {});
    }
    return Promise.all([
      story,
      manifest('bridge').then(function () { return chunk('bridge', 0); }),
      manifest('ground')
    ]).catch(function () {});
  }

  function mount(target) {
    build(target);
    buildOrgs();
    badgeStill.style.backgroundImage = 'url(' + BASE + 'badge-mark.webp)';
    // LOCAL (portal integration): the host's animated mark, if there is one. A visitor who
    // asked for less motion keeps the still.
    if (opts.liveMark && !calm.matches) {
      badgeLive.style.backgroundImage = 'url(' + opts.liveMark + ')';
      hasLive = true;
    }
    restMark();
    badge.addEventListener('click', function () { isOpen ? closePopup() : openPopup(); });
    docsTile.addEventListener('click', onLogoTile);
    apiTile.addEventListener('click', onLogoTile);
    popClose.addEventListener('click', closePopup);
    popBody.addEventListener('click', finishTyping);
    ['pointerenter', 'focus', 'touchstart'].forEach(function (evt) {
      badge.addEventListener(evt, prime, { passive: true, once: true });
    });
    window.addEventListener('resize', refit);
    // A host can move the badge after the window has settled: the portal's footer adapter writes
    // `--fb-inset` and `--fb-ftr-h` on this root from its own observer, which no resize event
    // follows. Nothing else writes the root's style, so this fires only for the host.
    if (window.MutationObserver) {
      new window.MutationObserver(refit).observe(root, {
        attributes: true, attributeFilter: ['style'],
      });
    }
    document.addEventListener('visibilitychange', onVisibility);

    // LOCAL (portal integration): no idle load. The story sheet arrives with the motion, behind
    // `prime`, because both are the animation and neither is the mark.
  }

  var api = {
    mount: mount,
    open: function () { openPopup(); },
    close: function () { closePopup(); },
    isOpen: function () { return isOpen; },
    // what the measurement harness reads; no behaviour depends on it
    probe: function () {
      return {
        primed: primed, open: isOpen, still: wantsStill(), scale: scaleKey(),
        sheets: { bridge: Object.keys(SHEETS.bridge).length,
                  ground: Object.keys(SHEETS.ground).length },
        storyLoaded: storySheetReady,
        region: region && { w: region.w, h: region.h },
        canvasPx: canvas.width * canvas.height + featherCanvas.width * featherCanvas.height,
        rafActive: !!birdRaf, feathers: feathers.length
      };
    }
  };
  global.FrevaBadge = api;
  Object.defineProperty(global, '__badgeProbe', { get: api.probe, configurable: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); });
  } else {
    mount();
  }

}(window));
