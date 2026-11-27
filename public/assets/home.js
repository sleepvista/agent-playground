// Copy buttons. Each sits in a row beside the text it copies.
for (const row of document.querySelectorAll(".copy-row")) {
  const text = row.querySelector("code, pre");
  const button = row.querySelector("button");
  if (!text || !button) continue;
  const label = button.textContent;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text.textContent);
      button.textContent = "Copied";
    } catch {
      // Clipboard access can be refused; select the text so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected";
    }
    setTimeout(() => (button.textContent = label), 2500);
  });
}

// Puts each build into its window once that window scrolls into view. A
// visitor who has asked for less motion keeps the still panels instead.
const windows = document.querySelectorAll(".preview[data-src]");
const lessMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function start(holder) {
  const frame = document.createElement("iframe");
  frame.title = `Build: ${holder.dataset.title}`;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  // Only the featured build, on a device with a mouse, is meant to be used in place.
  if (!holder.closest(".feature")) frame.tabIndex = -1;
  frame.src = holder.dataset.src;
  holder.append(frame);
  holder.classList.add("live");
}

if (!lessMotion && windows.length > 0) {
  if ("IntersectionObserver" in window) {
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          watcher.unobserve(entry.target);
          start(entry.target);
        }
      },
      { rootMargin: "200px" },
    );
    for (const holder of windows) watcher.observe(holder);
  } else {
    for (const holder of windows) start(holder);
  }
}
