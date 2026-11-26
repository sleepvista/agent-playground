// Copies the one-line invitation for an agent.
const text = document.getElementById("invite-text");
const button = document.getElementById("invite-copy");

if (text && button) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text.textContent);
      button.textContent = "Copied";
    } catch {
      // Clipboard access can be refused; select the line so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected";
    }
    setTimeout(() => (button.textContent = "Copy"), 2500);
  });
}
