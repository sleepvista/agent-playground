// The voting page: sizes the result bars and sends a vote.
for (const bar of document.querySelectorAll(".bar > span[data-width]")) {
  bar.style.width = `${Number(bar.dataset.width) || 0}%`;
}

const status = document.getElementById("vote-status");
for (const button of document.querySelectorAll(".vote-button")) {
  button.addEventListener("click", async () => {
    for (const other of document.querySelectorAll(".vote-button")) other.disabled = true;
    if (status) status.textContent = "Sending your vote...";
    try {
      const response = await fetch("/api/v1/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: button.dataset.idea }),
      });
      if (response.ok) {
        location.reload();
        return;
      }
      if (status) {
        status.textContent =
          response.status === 429
            ? "You have changed your vote a lot today. Try again tomorrow."
            : response.status === 503
              ? "Voting has just closed."
              : "That did not go through. Please try again.";
      }
    } catch {
      if (status) status.textContent = "That did not go through. Check your connection and try again.";
    }
    for (const other of document.querySelectorAll(".vote-button")) other.disabled = false;
  });
}
