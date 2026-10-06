# @freva-org/jupyterlite-climateclaw

[ClimateClaw](https://github.com/freva-org/climateclaw) at a Freva instance, inside JupyterLite and
JupyterLab ≥ 4.5, through [jupyterlite-ai](https://github.com/jupyterlite/ai) 0.20.x and its own
extension points only:

- a provider, **ClimateClaw (Freva)**, in jupyterlite-ai's provider registry;
- Freva sign-in in a popup - the page never navigates, the token stays in the page's memory;
- in the chat header (jupyterlite-ai's "Chat" toolbar): a **model chip** (`DKRZ · gpt-4.1 ▾`)
  that switches this chat's model, **Conversations** and the **account** (initials; sign-in and
  sign-out);
- in the composer (the chat input's own toolbar): **Add context** (the active cell, the selected
  cells, all cells, a file - or _follow the active cell_), **Prompts** (the examples; in
  ClimateClaw's own panel they are cards on a new chat instead) and **Code in chat / Code hidden**
  (whether the chat shows the code too; it is always in its notebook cell);
- a **Conversations** drawer in the right side bar: search, Today / Yesterday / Earlier, a menu
  per conversation, Show more, New chat;
- **Code into the notebook** (setting `codeToNotebook`, on by default): code ClimateClaw runs at
  DKRZ becomes a new cell at the end of the open notebook (a new notebook when none is open), typed
  out as it streams, with its output and figures, labelled _ran at DKRZ (ClimateClaw)_ - not this
  notebook's kernel. The chat keeps the explanation and, in the code's place, chips:
  _DKRZ · Cell 4 · notebook_, how it ended (_✓ ran · output_ or the error's name) and _figure_; the
  composer offers the jump to the cell. Code shown only as an example stays in the chat, with the
  chat's own insert and copy buttons. Off, code and outputs are shown in the chat;
- one slash command per example;
- **Run & fix at DKRZ** for notebook cells;
- the command `climateclaw:ask` (a question, optional context) for other extensions.

Published on npm and on PyPI as `jupyterlite-climateclaw` (the same prebuilt extension).
jupyterlite-ai and ClimateClaw are used as they are: nothing here patches, forks or bundles them.

## Configuration

Settings of the plugin `@freva-org/jupyterlite-climateclaw:plugin`, set by the operator through
settings overrides (`overrides.json`; `portal-builder prepare-notebook` writes them for a portal).
Nothing here is a credential.

| Setting             | Meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `host`              | The Freva host's origin, e.g. `https://freva.example.org`. Required.                          |
| `authBaseUrl`       | Default `{host}/api/freva-nextgen/auth/v2`.                                                   |
| `apiPath`           | Where ClimateClaw is served under the host. Default `/api/chatbot`.                           |
| `callbackPath`      | The sign-in callback on the notebook's origin (`/auth/callback/`). Default: the page shipped. |
| `expectedIssuer`    | The identity provider's issuer, when it sends `iss` (RFC 9207).                               |
| `defaultModel`      | The model preselected in the chat.                                                            |
| `runAndFixModel`    | A fast model for Run & fix. Default `defaultModel`.                                           |
| `scopeNote`         | Prepended to the first message of every new thread, and shown in the chat.                    |
| `examples`          | `[{ title, prompt }]`: the Examples menu and one slash command each.                          |
| `hideCodeByDefault` | Start with the code hidden in the chat (on whenever `codeToNotebook` is).                     |
| `codeToNotebook`    | Code ClimateClaw runs becomes notebook cells (default on).                                    |
| `hostLabel`         | The host's short name in the chat header, e.g. `DKRZ`. Default: derived from `host`.          |
| `previewOrigin`     | Where saved figures are served from (`preview_url`); shown from there. Default: `host`.       |

jupyterlite-ai's own settings preselect the provider and model (and keep inline completion off):

```json
{
  "@jupyternaut/persona:settings-model": {
    "providers": [
      {
        "id": "climateclaw",
        "name": "ClimateClaw",
        "provider": "climateclaw",
        "model": "gpt-5"
      }
    ],
    "defaultProvider": "climateclaw",
    "useSameProviderForChatAndCompleter": false,
    "useSecretsManager": false,
    "toolsEnabled": false
  },
  "@jupyterlite/ai:chat": { "chatBackupDirectory": "chats" }
}
```

Disable `@jupyternaut/persona:settings-panel` so the provider and model stay the site's. In
JupyterLite also disable `jupyter-mcp-manager:manager` (it needs a Jupyter server).

**ClimateClaw's own chat panel.** Disable `@jupyterlite/ai:chat` (jupyterlite-ai's chat panel) and
ClimateClaw shows chats in its own panel, on jupyterlite-ai's chat models (`IChatModelHandler`): a
header with the chat's name (click to rename), delete, _New chat_, _History_, open in a tab and the
account; a first page; the model picker beside Send (the chat's model; Run at DKRZ's is in its own
menu); Copy, read aloud and a rating under each reply; the time, Edit and Copy under each of the
user's messages, and versions of an edited message. It then provides the chat tracker and keeps
jupyterlite-ai's `open-chat`, `open-or-reveal-chat`, `move-chat` and `save-chat` commands working.
With that plugin enabled (a plain pip install), jupyterlite-ai's panel stays, with ClimateClaw's
header items and composer controls in it.

## Sign-in

The click on **Sign in with Freva** opens a blank popup synchronously (the only moment a browser
allows one), and the auth client's `navigate` sends that popup - never the page - to the login.
Before that, the page writes a record into the popup's session storage: a fresh attempt id, the
purpose (sign-in or sign-out) and an expiry (`src/auth-relay.ts`). The identity provider returns to
the callback on the notebook's origin, which takes the record once and posts its own URL on a
`BroadcastChannel` named after that attempt (not `window.opener`: a provider page with
Cross-Origin-Opener-Policy severs it), then closes. Only the page that started the attempt listens
there; it checks the message and exchanges the code, against the state, PKCE verifier and issuer it
holds. A second delivery, another tab's attempt, an expired record or a message of any other shape
is ignored or reported, never exchanged.

- **The callback:** a portal sets `callbackPath: /auth/callback/`, its shared callback, resolved
  against the notebook's origin (no host name in the settings). Without it, the page this package
  ships (`freva-login-callback.html`) does the same. That page also answers sign-ins started by an
  older version of this extension, on their attempt key and channel.
- **Register the callback URL** with the identity provider (Keycloak: _Valid redirect URIs_ and
  _Valid post logout redirect URIs_) and in freva-rest's redirect allow-list, e.g.
  `https://play.example.org/auth/callback/`.
- **Cancelled or refused:** the page says so ("The sign-in was cancelled.", "Freva did not accept
  the sign-in …"). An attempt lasts 10 minutes: past that, **Sign in** closes the old popup and
  opens a new one, and a callback that finds the record expired tells the notebook, which lets it
  go.
- **Framed by another site:** the frame's storage and channels are partitioned, so the callback
  also posts the response to the window that opened the popup (same origin only); the notebook
  accepts it only from that popup, and acknowledges. Without an acknowledgement (the provider's
  page has also cut the popup from its opener) the popup says to open the notebook in its own tab.
- **Blocked popup:** a notice says "Allow pop-ups or open the login in a new tab", with that link.
- **Storage:** this tab's sessionStorage, in the portal's format (key `portal:auth:token`): a reload
  stays signed in, a portal session on the same origin is reused, and closing the tab ends it. Other
  tabs do not share it, and the kernel's Python (in a Worker) cannot read it. Never localStorage, a
  URL or a jupyterlite-ai setting.
- **Sign out** revokes the credential where the server has `POST /revoke` and clears it, then ends
  the identity provider's session in a popup (never this page). Freva's py-oidc-auth has no
  `/revoke`: its 404 is accepted (`acknowledgeUnsupportedRevocation`); any other failed sign-out
  keeps the page locked until the next sign-in retries it.
- **Signed in** shows as a green dot on the account's avatar (the person's initials, or a person
  for an account id like `k204221`) and a short "Signed in as …" note when the sign-in happens.
  Signed in, ClimateClaw's panel opens on a new chat (its greeting and examples), not its welcome.
- The bearer is sent to the Freva host only, over HTTPS. The browser never sends
  `x-freva-rest-url`: ClimateClaw needs it, and the deployment's proxy sets it.
- Other extensions get the sign-in as the token `IFrevaAuth` (`fetch`, `accessToken`, `login`,
  `logout`, `signedIn`, `username`, `changed`). Its token object is shared through
  `Symbol.for("@freva-org/jupyterlite:IFrevaAuth")`, so the data panel can use it without
  depending on this package.

## The chat

Only the newest user message is sent (`POST {host}/api/chatbot/streamresponse`, with
`{ thread_id, input, chatbot }`); ClimateClaw keeps the conversation. A thread starts with
`GET /newthread` (ClimateClaw requires an id) and the chat records it: the first reply begins with
an HTML comment, `<!-- climateclaw:thread=ID -->`, which the chat's Markdown sanitiser hides and
which survives in the chat's messages, its saved `.chat` file and every history rebuild. A new
chat, or a cleared one, has no marker and starts a new thread; a stopped reply is remembered in
memory. A `ServerHint` that names another thread (ClimateClaw forks a thread opened by another
user) is followed.

| ClimateClaw variant          | In the chat                                                             |
| ---------------------------- | ----------------------------------------------------------------------- |
| `Assistant`                  | text                                                                    |
| `Code`                       | the streamed `{"code": …}` arguments, per id, as one python block       |
| `CodeOutput`                 | stdout/result/stderr as fenced blocks; an error under **Error**         |
| `Image`                      | 8 KiB base64 lines per id, reassembled into a `data:` image of its type |
| `ToolCall` / `ToolOutput`    | a short status line                                                     |
| `ServerHint`                 | a thread id is followed; a busy hint is a status line; others ignored   |
| `ServerError`, `OpenAIError` | an error the chat shows                                                 |
| `StreamEnd`                  | the end                                                                 |

Each run at DKRZ is a card: its line (DKRZ's logo, the cell, how it ended), its code, then its
Output, stderr, Error, Files and Figures, each folded by a click on its header. The **code** toggle
(Hide code) folds each run's code under its card's line; outputs, errors and figures always show.
Run at DKRZ's import check is not a card. **Stop** sends `POST /stop {thread_id}`. jupyterlite-ai's
title requests are answered locally (no request), so they never land in a thread.
**Conversations** lists `POST /getuserthreads` a page at a time; opening one (in the chat panel, or
beside the notebook) writes it as a chat file in the chat backup directory and opens it through
jupyterlite-ai's own restore path, so continuing it continues the thread.

**Saving.** ClimateClaw writes each chat's backup itself, one write at a time, from the model the
chat shows then. Autosave is one setting per chat, shown by both UIs: ClimateClaw's menu and
jupyterlite-ai's own autosave button toggle it, and a backup records it (a reload keeps it).
jupyterlite-ai's Save goes to the same saver; its debounced autosave writes nothing. Both hosts
(ClimateClaw's panel and jupyterlite-ai's) open, close, remove and replace a chat's model the same
way: a replaced model is let go everywhere the host keeps it (jupyterlite-ai's side panel caches
its models), so the chat opens on a new one.

**Context** goes in as @jupyter/chat attachments - the chips above the input - which
jupyterlite-ai's persona expands into the message (each cell's source and outputs, or a file's
text). Nothing is attached unless the user asks; _follow the active cell_ keeps the notebook's
active cell attached to every message until its chip is removed.

**ClimateClaw at work** shows beside Send: a mark, what it is doing - _Thinking_, _Writing code_,
_Running code at DKRZ_, _Drawing a figure_, _Using …_ - and for how long (the mark alone in a
narrow panel; still for reduced motion). The mark is its logo pecking while it thinks, lines of
code being typed while it writes code, DKRZ's logo in motion while it runs code, and a pen plotting
a curve on small axes while it draws a figure. When the reply is done it becomes a jump to the cell
(or a menu of the cells) the reply wrote. Replies, the "is typing" line and the header carry
ClimateClaw's name and logo: jupyterlite-ai's one persona is renamed through the chat model's own
API (message updates and the writers list, whose `typingIndicator` says "is thinking…", "is
writing code…", "is running code at DKRZ…"), only in chats that talk to ClimateClaw.

The composer's field grows with the question up to a share of the window, then scrolls, so Send
stays in view (in a framed page too). The composer shows full labels when wide, short labels when
medium and icons alone (with tooltips) when narrow; the model chip shows host and model, the model,
or its logo. A narrow side panel folds the header into jupyterlite-ai's "More commands" popup.

The **scope note** steers; it does not restrict. Only the ClimateClaw deployment can confine an
assistant to one portal's data (see the portal-builder documentation).

## Run & fix at DKRZ

A notebook toolbar button and cell context-menu item. It sends the cell to ClimateClaw with a fixed
instruction:

1. **Check what it imports first.** One short run at DKRZ looks for the modules the cell imports
   for certain: only its top-level imports (not the standard library's, nor one in a string or a
   comment). One inside a function, a class, an `if`, a `try` or its `except` fallback may never
   run, so it is not checked - if it runs and its module is missing, the error says so. If one is
   missing there, the cell is not run and not rewritten around it: the cell says which module DKRZ
   lacks and how to run it in the notebook's own Python instead (the Freva Python kernel, in the
   browser), and **Add install cell** (command `climateclaw:add-install-cell`) puts
   `await micropip.install([...])` above the cell. A module named by a `ModuleNotFoundError` counts
   too.
2. **Run it exactly**; only if it fails, fix the minimal cause and run the fix - at most 3 runs in
   all - and say in one line what changed. The limit is kept here, as far as the browser can: at a
   fourth run, nothing more is read and nothing from it is used, the server is asked to stop (the
   cell says whether it took the request within a few seconds - DKRZ may still finish that run; the
   wait ends with the job, so the notebook's next cell never waits on it), and the DKRZ session is
   given up, so the next run starts a new one. A reply with no run of the cell (only the import
   check, or text), or whose last run reported no result, is not a success.
3. The cell's outputs are its own run's (as written), labelled _ran at DKRZ (ClimateClaw)_, with one
   line per other run; when ClimateClaw ran a changed version first, the cell says so and those
   outputs go with the fix. A fix that ran without an error is offered with its diff: **Add fix
   below** (command `climateclaw:add-fix-below`) adds it as a new cell under yours, with the output
   of its run at DKRZ - yours stays as you wrote it; **Replace cell** (`climateclaw:apply-fix`) puts
   it in its place. After the last failed attempt the cell says ClimateClaw could not fix it (and
   why, when it says).

It is **not** this notebook's kernel and **not** exact execution: a model is in the loop, so it is
slower, costs tokens and is not deterministic, and nothing it defines exists in the notebook's
kernel. One thread per notebook, kept in the notebook's metadata with the notebook's path, so a copy
starts its own; a kernel restart, or **New DKRZ thread**, starts a new one, and a thread still being
made for the session before is not kept. The thread is one interpreter, so a notebook's cells run
there one at a time, and so do two notebooks that somehow share one: a cell asked for while another
runs says _Queued_ and starts when that one is done. The active cell's toolbar shows **Cancel
(queued)** or **Stop**: a stopped run is _Stopping_ until DKRZ has ended it (the next cell waits for
that), and a run whose stop is not confirmed within 15 s gives its thread up. A fix is offered for
applying only when ClimateClaw reports a structured result for the changed code that names no error.

## Commands

`climateclaw:ask` (`prompt`, `context`, `send`, `area`; a new chat, or the chat in front while it
is still blank, so a conversation is never interrupted), `climateclaw:account`,
`climateclaw:sign-in`, `climateclaw:sign-out`, `climateclaw:examples`, `climateclaw:example`,
`climateclaw:toggle-hide-code`, `climateclaw:history`, `climateclaw:open-thread`,
`climateclaw:new-chat`, `climateclaw:select-model`, `climateclaw:attach-active-cell`,
`climateclaw:attach-selected-cells`, `climateclaw:attach-notebook`, `climateclaw:attach-file`,
`climateclaw:follow-active-cell`, `climateclaw:run-and-fix`, `climateclaw:stop-run-and-fix`,
`climateclaw:apply-fix`, `climateclaw:add-fix-below`, `climateclaw:add-install-cell`,
`climateclaw:new-dkrz-thread`.

## In JupyterLite

`lite/jupyterlite-ai-requirements.txt` pins jupyterlite-ai 0.20.1 and the eight prebuilt extensions
it needs, with hashes. A site's prepare step downloads them from PyPI (`--require-hashes --no-deps
--only-binary=:all:`) and JupyterLite reads each wheel's extension; nothing of it is committed or
hosted by this project. `@freva-org/portal-builder prepare-notebook` does all of this for a portal.

## Known limits

- jupyterlite-ai 0.20.1 lists one model per configured provider entry and has no provider-side
  model listing yet, so after sign-in the models from `GET /availablechatbots` are added as further
  ClimateClaw entries. The provider also declares `fetchModels` and `connectAccount` for the next
  jupyterlite-ai release.
- jupyterlite-ai 0.20.1 has one persona ("Jupyternaut") and no setting for it: ClimateClaw renames
  it in its own chats, but jupyterlite-ai's own labels elsewhere (its settings menu entry) keep the
  name. It also hands its chat panel no message-footer registry (supported by @jupyter/chat), so
  "at work" lives beside Send rather than under the reply, and a reply's text can only grow, so the
  chips in a reply (where code ran, how it ended) are not links: the jump is the composer's.
- jupyterlite-ai 0.20.1 hands its chat panel no welcome message, empty-chat placeholder or chat
  placeholder factory (all supported by @jupyter/chat), so an empty chat cannot show examples or
  recent conversations; the chat title and the panel's own top row ("New chat", chat search,
  settings) are its own; and the @jupyter/chat 0.25.0 it bundles has a fixed input placeholder.
- @jupyter/chat merges a notebook's attachments into one chip, so the active cell and other cells
  of the same notebook show as one ("Untitled.ipynb: 2 cells").
- jupyterlite-ai's bundled zod probes `Function("")` once at start-up; a policy without
  `'unsafe-eval'` refuses it (zod then runs without it) and the browser reports one violation from
  `@jupyternaut/persona`'s bundle.

## Development

```bash
npm run build && npm run build:labextension
npm test                                    # unit tests
node browser-tests/climateclaw.mjs          # the Lab site against the mock Freva (Chromium)
node browser-tests/jupyterlab-smoke.mjs     # real JupyterLab 4.5.0 / 4.4.0 environments
node browser-tests/mock-freva.mjs           # the mock on its own
```
