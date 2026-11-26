// The water level is the minute of the hour: empty at :00, full at :59.
const ctx = canvas.getContext("2d");
const layers = [
  ["#123a54", 0.6, 18, 0.9],
  ["#1b587a", 0.9, 12, 1.4],
  ["#2a86a8", 1.3, 7, 2.1],
];

on("frame", (ms) => {
  const w = view.width;
  const h = view.height;
  const now = new Date();
  const fill = (now.getMinutes() * 60 + now.getSeconds()) / 3600;
  ctx.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0);
  ctx.fillStyle = "#0b2233";
  ctx.fillRect(0, 0, w, h);
  const level = h - 40 - fill * (h - 150);
  layers.forEach(([colour, speed, height, freq], layer) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 6; x += 6) {
      ctx.lineTo(x, level + layer * 14 + Math.sin(x * 0.01 * freq + ms * 0.001 * speed) * height + Math.sin(x * 0.023 + ms * 0.0007) * 4);
    }
    ctx.lineTo(w, h);
    ctx.fill();
  });
  ctx.fillStyle = "#cfe6f2";
  ctx.font = `600 ${Math.max(20, Math.min(44, w * 0.06))}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText(now.toTimeString().slice(0, 8), w / 2, 56);
});
