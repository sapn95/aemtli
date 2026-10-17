// A Copy button on every code box: what goose puts in a code block is mostly
// meant to be pasted somewhere else, and on a phone selecting a whole block
// by hand is fiddly. What is copied is the box's own text, never the button.

/** Puts a Copy button on each <pre> under `root` that has none yet. */
export function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('code-box')) continue;
    const box = document.createElement('div');
    box.className = 'code-box';
    pre.replaceWith(box);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy quiet-button';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select it by hand';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    });
    box.append(pre, button);
  }
}
