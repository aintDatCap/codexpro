import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { ChatGPTSubagentProject } from "../dist/chatgptSubagentProject.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-project-ui-"));
const destination = "https://chatgpt.com/g/g-p-browser-fixture-codexpro/project";
const fixture = `<!doctype html>
<html><head><title>Mock ChatGPT projects</title></head><body>
<aside>
  <button id="projects-header">Progetti</button>
  <button id="new-project" hidden>Aggiungi nuovo progetto</button>
  <button id="existing-project" hidden>CodexPro - Subagenti</button>
  <button id="new-chat-in-project" hidden>Nuova chat in CodexPro - Subagenti</button>
</aside>
<main><h1 id="project-heading" hidden>CodexPro - Subagenti</h1></main>
<dialog id="create-dialog">
  <label>Nome del progetto <input type="text" aria-label="Nome del progetto"></label>
  <button id="create">Crea progetto</button>
</dialog>
<script>
  const projectUrl = "/g/g-p-browser-fixture-codexpro/project";
  const existing = document.getElementById("existing-project");
  const newChat = document.getElementById("new-chat-in-project");
  const heading = document.getElementById("project-heading");
  const dialog = document.getElementById("create-dialog");
  const present = () => localStorage.getItem("project-created") === "yes";
  function render() {
    existing.hidden = !present();
    heading.hidden = !present() || location.pathname !== projectUrl;
  }
  document.getElementById("projects-header").onmouseenter = () => { document.getElementById("new-project").hidden = false; };
  document.getElementById("new-project").onclick = () => dialog.showModal();
  existing.onclick = () => { existing.dataset.expanded = "true"; };
  existing.onmouseenter = () => { newChat.hidden = !present(); };
  newChat.onclick = () => { history.pushState({}, "", projectUrl); render(); };
  document.getElementById("create").onclick = () => {
    if (dialog.querySelector("input").value !== "CodexPro - Subagenti") return;
    localStorage.setItem("project-created", "yes");
    localStorage.setItem("creation-count", String(Number(localStorage.getItem("creation-count") || "0") + 1));
    history.pushState({}, "", projectUrl);
    dialog.close();
    render();
  };
  render();
</script></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  try {
    // Only a local simulated HTML fixture is served: no authenticated
    // ChatGPT page, real project, cookie, or user content is accessed.
    await context.route("https://chatgpt.com/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture });
    });

    const project = new ChatGPTSubagentProject(path.join(temp, "private-profile"));
    const page = await context.newPage();
    assert.equal(await project.ensure(page), destination);
    assert.equal(await page.evaluate(() => localStorage.getItem("creation-count")), "1");

    const nextPage = await context.newPage();
    const reused = new ChatGPTSubagentProject(path.join(temp, "private-profile"));
    assert.equal(await reused.ensure(nextPage), destination);
    assert.equal(await nextPage.evaluate(() => localStorage.getItem("creation-count")), "1");
    assert.equal(await nextPage.getByRole("heading", { name: "CodexPro - Subagenti" }).isVisible(), true);

    // Simulate an existing Italian-language project with no create control.
    await nextPage.evaluate(() => {
      document.getElementById("new-project").hidden = true;
    });
    const buttonOnly = new ChatGPTSubagentProject(path.join(temp, "uncached-profile"));
    assert.equal(await buttonOnly.ensure(nextPage), destination);
    assert.equal(await nextPage.evaluate(() => localStorage.getItem("creation-count")), "1");

    await context.close();
    console.log("ChatGPT project UI Chromium smoke passed");
  } finally {
    await context.close().catch(() => {});
  }
} finally {
  await browser.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
