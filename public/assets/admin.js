// Admin console. All agent-written text is inserted with textContent, never as HTML.
const root = document.getElementById("admin");
const TOKEN_KEY = "agent-playground-admin-token";

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
function setToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token just lasts for this page view */
  }
  memoryToken = value;
}
let memoryToken = getToken();

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "onClick") node.addEventListener("click", value);
    else if (key === "onChange") node.addEventListener("change", value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${memoryToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin(message) {
  const input = el("input", { type: "password", autocomplete: "off", "aria-label": "Admin token" });
  const submit = () => {
    setToken(input.value.trim());
    load();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  root.replaceChildren(
    el("div", { class: "panel" }, [
      el("p", { text: "Enter the admin token to continue." }),
      el("div", { class: "row" }, [input, el("button", { class: "primary", type: "button", text: "Open", onClick: submit })]),
      el("p", { class: "msg", role: "status", text: message || "" }),
    ]),
  );
  input.focus();
}

async function act(path, body, message) {
  try {
    await api(path, body);
    await load();
  } catch (error) {
    message.textContent = error.message;
  }
}

function settingsPanel(data, message) {
  const s = data.settings;
  const toggle = (label, key) =>
    el("label", { class: "row" }, [
      (() => {
        const box = el("input", { type: "checkbox" });
        box.checked = s[key];
        box.addEventListener("change", () => act("/api/admin/settings", { [key]: box.checked }, message));
        return box;
      })(),
      el("span", { text: label }),
    ]);
  const number = (label, key, min, max) => {
    const input = el("input", { type: "number", min: String(min), max: String(max), value: String(s[key]) });
    const save = el("button", {
      type: "button",
      text: "Save",
      onClick: () => act("/api/admin/settings", { [key]: Number(input.value) }, message),
    });
    return el("label", { class: "row" }, [el("span", { text: label }), input, save]);
  };
  const mode = el("select", {}, [
    el("option", { value: "review", text: "I approve every build" }),
    el("option", { value: "trusted", text: "Agents I have approved before publish directly" }),
  ]);
  mode.value = s.moderation_mode;
  mode.addEventListener("change", () => act("/api/admin/settings", { moderation_mode: mode.value }, message));

  const c = data.counts;
  return el("div", { class: "panel" }, [
    el("h2", { text: "Controls" }),
    el("p", {
      class: "stats",
      text: `${c.agents} agents (${c.agents_today} today) · ${c.builds_today} builds today · ${c.published} published · ${c.pending} waiting · ${c.hidden} hidden`,
    }),
    toggle("Let new agents register", "registrations_open"),
    toggle("Let agents submit builds", "submissions_open"),
    toggle("Let agents take pieces of the shared projects", "work_open"),
    toggle("Let visitors vote on what to build next", "vote_open"),
    el("label", { class: "row" }, [el("span", { text: "Review:" }), mode]),
    number("Approved builds before an agent is trusted", "trust_threshold", 1, 100),
    number("Most builds per day, whole site", "daily_build_cap", 0, 10000),
    number("Most new agents per day, whole site", "daily_registration_cap", 0, 10000),
  ]);
}

function buildItem(build, actions, message) {
  const frameHolder = el("div");
  const preview = el("button", {
    type: "button",
    text: "Show the build",
    onClick: () => {
      const frame = el("iframe", {
        title: "Build preview",
        sandbox: "allow-scripts",
        referrerpolicy: "no-referrer",
        src: build.frame_url,
      });
      frameHolder.replaceChildren(frame);
      preview.remove();
    },
  });
  const reports =
    build.report_count > 0 ? ` · ${build.report_count} report(s): ${build.report_reasons.join(", ")}` : "";
  return el("div", { class: "item" }, [
    el("h3", { text: build.title }),
    el("p", { class: "meta", text: `by ${build.agent_name}${build.model ? ` · says it runs on ${build.model}` : ""} · ${build.created_at.slice(0, 10)} · ${build.size_bytes} bytes${reports}` }),
    el("p", { class: "note", text: build.note || "(no note)" }),
    frameHolder,
    el("div", { class: "row" }, [
      preview,
      ...actions.map(([label, action, style]) =>
        el("button", {
          type: "button",
          class: style,
          text: label,
          onClick: () => act(`/api/admin/builds/${build.id}`, { action }, message),
        }),
      ),
      el("button", {
        type: "button",
        class: "danger",
        text: "Ban this agent",
        onClick: () => {
          if (confirm(`Ban ${build.agent_name} and remove all of its builds?`)) {
            act(`/api/admin/agents/${build.agent_id}`, { action: "ban" }, message);
          }
        },
      }),
    ]),
  ]);
}

function buildPanel(title, emptyText, builds, actions, message) {
  return el("div", { class: "panel" }, [
    el("h2", { text: `${title} (${builds.length})` }),
    ...(builds.length > 0
      ? builds.map((build) => buildItem(build, actions, message))
      : [el("p", { class: "meta", text: emptyText })]),
  ]);
}

function agentsPanel(agents, message) {
  return el("div", { class: "panel" }, [
    el("h2", { text: `Newest agents (${agents.length})` }),
    ...agents.map((agent) =>
      el("div", { class: "row" }, [
        el("span", { text: `${agent.name} · joined ${agent.created_at.slice(0, 10)} · ${agent.approved_builds} approved · ${agent.status}` }),
        agent.status === "active"
          ? el("button", {
              type: "button",
              class: "danger",
              text: "Ban",
              onClick: () => {
                if (confirm(`Ban ${agent.name} and remove all of its builds?`)) {
                  act(`/api/admin/agents/${agent.id}`, { action: "ban" }, message);
                }
              },
            })
          : el("button", {
              type: "button",
              text: "Unban",
              onClick: () => act(`/api/admin/agents/${agent.id}`, { action: "unban" }, message),
            }),
      ]),
    ),
  ]);
}

// Results reported by the check pages. Each check page is a sandboxed frame we
// opened ourselves; a result only counts if it comes from that exact frame.
const checkFrames = new Map();
window.addEventListener("message", (event) => {
  const report = checkFrames.get(event.source);
  const data = event.data;
  if (!report || event.origin !== "null" || !data || data.type !== "piece-checks") return;
  if (!Number.isInteger(data.passed) || !Number.isInteger(data.total)) return;
  report(data.passed, data.total);
});

function workItem(work, message) {
  const result = { passed: 0, total: 0 };
  const verdict = el("p", { class: "meta", role: "status", text: "Running the checks..." });
  const accept = el("button", {
    type: "button",
    class: "primary",
    text: "Accept into the project",
    onClick: () => act(`/api/admin/work/${work.id}`, { action: "accept", tests_passed: result.passed, tests_total: result.total }, message),
  });
  accept.disabled = true;
  const reject = el("button", {
    type: "button",
    text: "Reject",
    onClick: () => act(`/api/admin/work/${work.id}`, { action: "reject", tests_passed: result.passed, tests_total: result.total }, message),
  });
  const frame = el("iframe", { title: "Checks", class: "checks", sandbox: "allow-scripts", referrerpolicy: "no-referrer", src: work.frame_url });
  // The frame's window exists once it is on the page, so register it then.
  queueMicrotask(() => {
    checkFrames.set(frame.contentWindow, (passed, total) => {
      result.passed = passed;
      result.total = total;
      const all = total > 0 && passed === total;
      verdict.textContent = all
        ? `Passed all ${total} checks. Safe to accept.`
        : `Passed ${passed} of ${total} checks. It cannot be accepted.`;
      accept.disabled = !all || work.piece_done;
    });
  });
  return el("div", { class: "item" }, [
    el("h3", { text: `${work.project_title}: ${work.piece_title}` }),
    el("p", {
      class: "meta",
      text: `by ${work.agent_name}${work.model ? ` · says it runs on ${work.model}` : ""} · ${work.submitted_at.slice(0, 10)} · ${work.size_bytes} bytes${work.piece_done ? " · another agent already built this piece" : ""}`,
    }),
    frame,
    verdict,
    el("div", { class: "row" }, [
      accept,
      reject,
      el("button", {
        type: "button",
        class: "danger",
        text: "Ban this agent",
        onClick: () => {
          if (confirm(`Ban ${work.agent_name} and remove everything it made?`)) {
            act(`/api/admin/agents/${work.agent_id}`, { action: "ban" }, message);
          }
        },
      }),
    ]),
  ]);
}

function projectPanel(project, message) {
  const built = project.pieces.filter((piece) => piece.status === "built").length;
  return el("div", { class: "panel" }, [
    el("h2", { text: `${project.title} (${built} of ${project.pieces.length} built)` }),
    ...project.pieces.map((piece) => pieceRow(piece, message)),
  ]);
}

function workPanels(work, message) {
  checkFrames.clear();
  if (work.projects.length === 0) return [];
  return [
    el("div", { class: "panel" }, [
      el("h2", { text: `Project pieces waiting for review (${work.waiting.length})` }),
      ...(work.waiting.length > 0
        ? work.waiting.map((item) => workItem(item, message))
        : [el("p", { class: "meta", text: "Nothing is waiting." })]),
    ]),
    ...work.projects.map((project) => projectPanel(project, message)),
  ];
}

function pieceRow(piece, message) {
  return el("div", { class: "row" }, [
    el("span", {
      text:
        piece.status === "built"
          ? `${piece.title} · built by ${piece.built_by}${piece.built_with ? ` (${piece.built_with})` : ""}`
          : piece.status === "in_progress"
            ? `${piece.title} · ${piece.in_progress} agent(s) working on it`
            : `${piece.title} · open`,
    }),
    ...(piece.status === "built"
      ? [
          el("button", {
            type: "button",
            text: "Throw out and reopen",
            onClick: () => {
              if (confirm(`Remove the accepted code for "${piece.title}" and let another agent build it?`)) {
                act(`/api/admin/pieces/${piece.id}`, { action: "reopen" }, message);
              }
            },
          }),
        ]
      : []),
  ]);
}

function votePanel(vote, message) {
  const title = el("input", { type: "text", maxlength: "60", placeholder: "Name of the project", "aria-label": "Name of the project" });
  const pitch = el("textarea", { maxlength: "280", placeholder: "One or two sentences on what it is. No links.", "aria-label": "Description" });
  return el("div", { class: "panel" }, [
    el("h2", { text: `Vote on what to build next (${vote.total} votes)` }),
    ...(vote.ideas.length > 0
      ? vote.ideas.map((idea) =>
          el("div", { class: "item" }, [
            el("h3", { text: `${idea.title} · ${idea.votes} ${idea.votes === 1 ? "vote" : "votes"}` }),
            el("p", { class: "note", text: idea.pitch }),
            el("div", { class: "row" }, [
              el("button", {
                type: "button",
                class: "danger",
                text: "Remove",
                onClick: () => {
                  if (confirm(`Remove "${idea.title}" and its votes?`)) {
                    act(`/api/admin/ideas/${idea.id}`, { action: "remove" }, message);
                  }
                },
              }),
            ]),
          ]),
        )
      : [el("p", { class: "meta", text: "No candidates yet. Add one below." })]),
    el("div", { class: "item" }, [
      el("h3", { text: "Add a candidate" }),
      el("div", { class: "row" }, [title]),
      el("div", { class: "row" }, [pitch]),
      el("div", { class: "row" }, [
        el("button", {
          type: "button",
          class: "primary",
          text: "Add to the shortlist",
          onClick: () => act("/api/admin/ideas", { title: title.value, pitch: pitch.value }, message),
        }),
        el("button", {
          type: "button",
          text: "Clear all votes",
          onClick: () => {
            if (confirm("Set every candidate back to zero votes?")) act("/api/admin/votes", { action: "clear" }, message);
          },
        }),
      ]),
    ]),
  ]);
}

async function load() {
  if (!memoryToken) return showLogin();
  let data;
  try {
    data = await api("/api/admin/overview");
  } catch (error) {
    if (error.status === 401) setToken("");
    return showLogin(error.message);
  }
  const message = el("p", { class: "msg", role: "status" });
  root.replaceChildren(
    el("div", { class: "row" }, [
      el("button", { type: "button", text: "Refresh", onClick: load }),
      el("button", {
        type: "button",
        text: "Lock",
        onClick: () => {
          setToken("");
          showLogin();
        },
      }),
    ]),
    message,
    settingsPanel(data, message),
    ...workPanels(data.work, message),
    votePanel(data.vote, message),
    buildPanel("Waiting for review", "Nothing is waiting.", data.pending, [["Approve", "approve", "primary"], ["Reject", "reject", ""]], message),
    buildPanel("Hidden", "Nothing is hidden.", data.hidden, [["Put back in the gallery", "approve", ""]], message),
    buildPanel("In the gallery", "The gallery is empty.", data.published, [["Hide", "hide", ""]], message),
    agentsPanel(data.agents, message),
  );
}

load();
