// A flock that keeps together but is nervous of the pointer.
const ctx = canvas.getContext("2d");
const birds = Array.from({ length: 140 }, () => ({
  x: Math.random() * view.width,
  y: Math.random() * view.height,
  vx: Math.random() * 2 - 1,
  vy: Math.random() * 2 - 1,
}));

on("frame", () => {
  const w = view.width;
  const h = view.height;
  ctx.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0);
  ctx.fillStyle = "rgba(243, 239, 230, 0.35)";
  ctx.fillRect(0, 0, w, h);
  for (const b of birds) {
    let cx = 0, cy = 0, ax = 0, ay = 0, sx = 0, sy = 0, near = 0;
    for (const o of birds) {
      const dx = o.x - b.x, dy = o.y - b.y, d2 = dx * dx + dy * dy;
      if (o === b || d2 > 3600) continue;
      cx += o.x; cy += o.y; ax += o.vx; ay += o.vy; near++;
      if (d2 < 260) { sx -= dx; sy -= dy; }
    }
    if (near) {
      b.vx += (cx / near - b.x) * 0.0006 + (ax / near - b.vx) * 0.04 + sx * 0.02;
      b.vy += (cy / near - b.y) * 0.0006 + (ay / near - b.vy) * 0.04 + sy * 0.02;
    }
    if (pointer.inside) {
      const px = b.x - pointer.x, py = b.y - pointer.y, pd = Math.hypot(px, py) || 1;
      if (pd < 110) { b.vx += (px / pd) * 0.6; b.vy += (py / pd) * 0.6; }
    }
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const target = Math.min(Math.max(speed, 1.2), 3.2);
    b.vx = (b.vx / speed) * target;
    b.vy = (b.vy / speed) * target;
    b.x = (b.x + b.vx + w) % w;
    b.y = (b.y + b.vy + h) % h;
    const a = Math.atan2(b.vy, b.vx);
    ctx.fillStyle = "#2b3a42";
    ctx.beginPath();
    ctx.moveTo(b.x + Math.cos(a) * 7, b.y + Math.sin(a) * 7);
    ctx.lineTo(b.x + Math.cos(a + 2.5) * 4, b.y + Math.sin(a + 2.5) * 4);
    ctx.lineTo(b.x + Math.cos(a - 2.5) * 4, b.y + Math.sin(a - 2.5) * 4);
    ctx.fill();
  }
});
