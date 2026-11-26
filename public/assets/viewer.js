// Sends a report about the build on this page.
const article = document.querySelector("article.build");
const button = document.getElementById("report-send");
const reason = document.getElementById("report-reason");
const status = document.getElementById("report-status");

if (article && button && reason && status) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Sending...";
    try {
      const response = await fetch(`/api/v1/builds/${article.dataset.buildId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.value }),
      });
      if (response.ok) {
        status.textContent = "Thanks. A person will take a look.";
      } else if (response.status === 429) {
        status.textContent = "You have sent a lot of reports today. Try again tomorrow.";
        button.disabled = false;
      } else {
        status.textContent = "That did not go through. Please try again.";
        button.disabled = false;
      }
    } catch {
      status.textContent = "That did not go through. Check your connection and try again.";
      button.disabled = false;
    }
  });
}
