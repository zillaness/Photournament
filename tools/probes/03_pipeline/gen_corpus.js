// Synthetic camera-resolution JPEG corpus generator.
// Runs in the page (needs createPattern + convertToBlob). Draws a scene with
// enough real high-frequency content that JPEG compresses it like a photo
// rather than like a flat colour field.

const W = 4000, H = 3000;

// Deterministic PRNG so the corpus is reproducible across runs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A 256x256 tile of per-pixel noise. Drawn with createPattern at 1:1 scale so
// the noise survives at full frequency (a scaled drawImage would interpolate it
// away and the JPEG would compress unrealistically well).
function noiseTile(rnd, mono) {
  const t = new OffscreenCanvas(256, 256);
  const c = t.getContext('2d');
  const img = c.createImageData(256, 256);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (mono) {
      const v = (rnd() * 255) | 0;
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    } else {
      d[i] = (rnd() * 255) | 0;
      d[i + 1] = (rnd() * 255) | 0;
      d[i + 2] = (rnd() * 255) | 0;
    }
    d[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return t;
}

function drawScene(ctx, seed) {
  const rnd = mulberry32(seed);
  const hue = rnd() * 360;

  // 1. Base sky/ground gradient.
  const g = ctx.createLinearGradient(0, 0, rnd() * W, H);
  g.addColorStop(0, `hsl(${hue}, ${40 + rnd() * 50}%, ${55 + rnd() * 30}%)`);
  g.addColorStop(0.5, `hsl(${(hue + 40) % 360}, ${30 + rnd() * 50}%, ${30 + rnd() * 40}%)`);
  g.addColorStop(1, `hsl(${(hue + 200) % 360}, ${20 + rnd() * 60}%, ${10 + rnd() * 40}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 2. Large soft blobs — mid-frequency structure.
  for (let i = 0; i < 24; i++) {
    const x = rnd() * W, y = rnd() * H, r = 200 + rnd() * 1400;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const h2 = (hue + rnd() * 360) % 360;
    rg.addColorStop(0, `hsla(${h2}, 70%, ${20 + rnd() * 60}%, ${0.25 + rnd() * 0.5})`);
    rg.addColorStop(1, `hsla(${h2}, 70%, 50%, 0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 3. Hard-edged shapes — sharp edges, ringing, real DCT cost.
  for (let i = 0; i < 160; i++) {
    ctx.save();
    ctx.globalAlpha = 0.25 + rnd() * 0.7;
    ctx.fillStyle = `hsl(${rnd() * 360}, ${40 + rnd() * 60}%, ${10 + rnd() * 80}%)`;
    ctx.translate(rnd() * W, rnd() * H);
    ctx.rotate(rnd() * Math.PI * 2);
    const k = rnd();
    if (k < 0.35) {
      ctx.fillRect(0, 0, 20 + rnd() * 500, 20 + rnd() * 400);
    } else if (k < 0.7) {
      ctx.beginPath();
      ctx.ellipse(0, 0, 15 + rnd() * 350, 15 + rnd() * 350, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      const n = 3 + ((rnd() * 5) | 0);
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2, r = 40 + rnd() * 400;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // 4. Fine strokes — high-frequency detail (foliage/hair/texture analogue).
  ctx.lineCap = 'round';
  for (let i = 0; i < 2200; i++) {
    ctx.strokeStyle = `hsla(${rnd() * 360}, ${30 + rnd() * 70}%, ${5 + rnd() * 90}%, ${0.2 + rnd() * 0.8})`;
    ctx.lineWidth = 0.5 + rnd() * 3.5;
    const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI * 2, len = 10 + rnd() * 260;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // 5. Sensor-grain analogue: 1:1 repeated noise pattern over the whole frame.
  const pat = ctx.createPattern(noiseTile(rnd, false), 'repeat');
  ctx.save();
  ctx.globalAlpha = 0.13 + rnd() * 0.07;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const pat2 = ctx.createPattern(noiseTile(rnd, true), 'repeat');
  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = pat2;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

async function makeOne(seed, quality) {
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: false });
  drawScene(ctx, seed);
  return cv.convertToBlob({ type: 'image/jpeg', quality });
}

window.__genOne = makeOne;

// Generate `count` images and hand each to the driver via a download click.
window.__genAndDownload = async function (start, count, quality, names) {
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const blob = await makeOne(start + i, quality);
    sizes.push(blob.size);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = names[i];
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the download machinery a beat, then release the blob.
    await new Promise((r) => setTimeout(r, 0));
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    document.getElementById('log').textContent = `${i + 1}/${count} ${blob.size}`;
  }
  return sizes;
};
