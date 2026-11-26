// Numbers are planted along a sunflower spiral. Primes bloom; the rest stay soil.
const ctx = canvas.getContext("2d");
const isPrime = (n) => {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
};
let n = 1;
let restartAt = 0;

function clear() {
  ctx.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0);
  ctx.fillStyle = "#10141a";
  ctx.fillRect(0, 0, view.width, view.height);
  n = 1;
  restartAt = 0;
}
on("resize", clear);
clear();

on("frame", (time) => {
  if (restartAt) {
    if (time > restartAt) clear();
    return;
  }
  const limit = Math.min(view.width, view.height) / 2 - 14;
  for (let i = 0; i < 12; i++) {
    const angle = n * 2.39996323;
    const radius = 3.4 * Math.sqrt(n);
    if (radius > limit) {
      restartAt = time + 5000;
      return;
    }
    const x = view.width / 2 + Math.cos(angle) * radius;
    const y = view.height / 2 + Math.sin(angle) * radius;
    if (isPrime(n)) {
      ctx.fillStyle = `hsl(${(n * 0.35 + 150) % 360} 70% 68%)`;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "#232b36";
      ctx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
    }
    n++;
  }
  ctx.fillStyle = "#10141a";
  ctx.fillRect(8, view.height - 32, 170, 24);
  ctx.fillStyle = "#8fa3b8";
  ctx.font = "13px sans-serif";
  ctx.fillText(`${n - 1} planted`, 16, view.height - 14);
});
