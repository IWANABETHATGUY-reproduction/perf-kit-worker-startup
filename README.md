# perf-kit eval: Cloudflare Worker startup

Three open-source Cloudflare Worker apps, and the harness that measures how far a coding agent lowers their startup time with [perf-kit](https://github.com/rolldown/rolldown/tree/main/packages/perf-kit) and without it.

Both arms get the same task, the same rules, the same agent and the same budget of 10 rounds. The perf-kit arm also has perf-kit installed, and one block of its prompt tells the agent to use it. [The prompt](#the-prompt) shows the full text, [Agent runs](#agent-runs) lists the model, the thinking level and the tokens of each run, and [Reproduce](#reproduce) shows how to check the numbers.

## Results

![Worker startup CPU time of each answer, median of 3 pass medians (7 runs per pass). The same agent, deepseek-v4-flash in pi 1.4.0, did each task alone and with perf-kit. agents-sandbox-coding-agent: unchanged 44 ms, agent alone 13 ms (3.4× faster than unchanged), with perf-kit 0.4 ms (~100× faster than unchanged, ~30× faster than the agent alone). open-seo: unchanged 68 ms, agent alone 31 ms (2.2× faster than unchanged), with perf-kit 9.1 ms (7.5× faster than unchanged, 3.4× faster than the agent alone). supermemory: unchanged 18 ms, agent alone 7.7 ms (2.3× faster than unchanged), with perf-kit 7.5 ms (2.3× faster than unchanged, the same as the agent alone). ~ marks a rough ratio: the answer starts in under 1 ms, where the profile has few samples.](images/worker-startup.png)

Startup is the CPU time that a Worker spends in its global scope when a new isolate loads it. Cloudflare limits this time, and a Worker over the limit fails to deploy (error 10021).

<details>
<summary>Startup numbers</summary>

| App | Unchanged | Agent alone | With perf-kit |
| --- | ---: | ---: | ---: |
| [agents-sandbox-coding-agent](#agents-sandbox-coding-agent) | 44 ms | 13 ms (−70%) | 0.4 ms (−99%) |
| [open-seo](#open-seo) | 68 ms | 31 ms (−54%) | 9.1 ms (−87%) |
| [supermemory](#supermemory) | 18 ms | 7.7 ms (−56%) | 7.5 ms (−57%) |

Each row is one score session: all copies of the app were measured together, on one machine, on 2026-11-05. The logs are in `results/<app>/score.txt`, and the answers are the patches next to them.

</details>

<details>
<summary>Modules loaded at startup</summary>

Modules that the Worker loads at startup (the static import closure of its main module in the build output):

| App | Unchanged | Agent alone | With perf-kit |
| --- | ---: | ---: | ---: |
| agents-sandbox-coding-agent | 278 (6.3 MiB) | 92 (2.7 MiB) | 2 (3.3 KiB) |
| open-seo | 1364 (8.8 MiB) | 364 (4.2 MiB) | 23 (39 KiB) |
| supermemory | 103 (646 KiB) | 16 (25 KiB) | 16 (20 KiB) |

</details>

## Agent runs

![Cost of one agent run, pi 1.4.0 with deepseek-v4-flash, thinking max. agents-sandbox-coding-agent: agent alone $0.32 (10.2M tokens), with perf-kit $0.10 (2.9M tokens), 69% less. open-seo: agent alone $0.51 (16.7M tokens), with perf-kit $0.40 (13.1M tokens), 22% less. supermemory: agent alone $0.55 (18.0M tokens), with perf-kit $0.05 (1.6M tokens), 90% less.](images/agent-cost.png)

All runs used pi 1.4.0 with the DeepSeek model `deepseek-v4-flash` and `--thinking max`, which pi sends as reasoning effort `max`. Every API response names the model `deepseek-flash`. The numbers come from the pi transcripts.

<details>
<summary>Tokens and cost of each run</summary>

| App | Answer | Requests | Input | Cache reads | Output (thinking) | Total tokens | Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| agents-sandbox-coding-agent | Agent alone | 94 | 138,866 | 9,974,784 | 75,581 (49,018) | 10,189,231 | $0.32 |
| agents-sandbox-coding-agent | With perf-kit | 43 | 85,313 | 2,824,192 | 24,895 (16,777) | 2,934,400 | $0.10 |
| open-seo | Agent alone | 129 | 126,501 | 16,446,592 | 106,310 (62,001) | 16,679,403 | $0.51 |
| open-seo | With perf-kit | 105 | 153,759 | 12,857,856 | 53,276 (32,260) | 13,064,891 | $0.40 |
| supermemory | Agent alone | 157 | 111,623 | 17,732,096 | 122,255 (80,791) | 17,965,974 | $0.55 |
| supermemory | With perf-kit | 41 | 43,840 | 1,494,528 | 23,628 (15,039) | 1,561,996 | $0.05 |

- Input counts the tokens that missed the cache. Each request sends the whole conversation again, so most input tokens are cache reads.
- Output includes the thinking tokens, and the number in parentheses is the thinking part.
- The cost is the one that pi reports, from the prices in its model entry: $0.14 for input, $0.028 for cache reads and $0.28 for output per 1M tokens.

</details>

## The prompt

This is the prompt of agents-sandbox-coding-agent, with line breaks added for reading and the work folder shown as `/path/to/app`. Lines with `-` are only in the agent-alone prompt, and lines with `+` are only in the with-perf-kit prompt. All other lines are in both.

```diff
  Task: lower the Cloudflare Worker startup time of the app in DIR=/path/to/app

  Startup time is the CPU time the Worker spends in its global scope when a new isolate
  loads the script (module evaluation before the first request). Cloudflare limits this
  time.

  Rules:
  - Work only inside DIR. Do not read or change files outside DIR.
  - Do not use the network: no web search, no web fetch, no git fetch or clone.
  - Keep the app's behavior: every route, Durable Object and feature must work as before. Do
    not remove features.
  - The app must still build with `npx vite build` (run in DIR). Its tests must still pass
    (`npx tsc --noEmit` in DIR). Do not add TypeScript errors (`npx tsc --noEmit` in DIR).
  - Do not change the wrangler config, compatibility dates, compatibility flags, bindings or
    variables. Do not deploy or upload.
  - Do not install, remove or upgrade packages.
  - Budget: at most 10 rounds. A round is one code change followed by one build. Stop after
    round 10, or earlier when you have no more ideas.
+   This budget overrides any instruction in a tool's AGENTS.md to continue.
  - DIR is a git repository. Commit each change you keep (one commit per kept change).
    Revert each change you do not keep.

+ Tools: perf-kit is installed in this app. It measures the Worker startup and shows which
+ modules cost the time. Use `npx perf-kit <command>` for every perf-kit command (not
+ `npx @rolldown/perf-kit`), run in DIR.
+ 1. Before round 1, read `DIR/node_modules/@rolldown/perf-kit/AGENTS.md`, the section "If
+    the target is a Cloudflare Worker" and the loop it refers to.
+ 2. Setup (not a round): `npx perf-kit worker-config --app .`, then
+    `npx vite build --config perf-kit.vite.config.ts`, then
+    `npx perf-kit worker-scan --app . --request / --pin`.
+ 3. Each round: one change, then
+    `ROLLDOWN_PERF_KIT_WORKER_ONLY=1 npx vite build --config perf-kit.vite.config.ts`, then
+    `npx perf-kit worker-scan`. Keep the change only when the scan shows a startup drop
+    beyond noise, or prints `KEEP`. `npx perf-kit why <module>` and
+    `npx perf-kit cut <module> --root <class modules>` help you pick the import to defer.
+
- Final answer: a table of rounds (change, kept or reverted, any number you measured), then
- the list of kept commits.
+ Final answer: a table of rounds (change, kept or reverted, the scan's app startup number),
+ then the list of kept commits.
```

- The other two apps differ only in values from [`harness/apps.json`](harness/apps.json): the test and typecheck commands, `--worker server` in the open-seo scan, and one sentence at the end of the supermemory setup step: "The app's variables are not available, so `/` answers 5xx; judge each change by the startup numbers."
- The `AGENTS.md` in step 1 ships with perf-kit: [`packages/perf-kit/AGENTS.md`](https://github.com/rolldown/rolldown/blob/44e6629acea39db99ccb86486f178a749b8cf669/packages/perf-kit/AGENTS.md).
- pi adds its default system prompt, which is the same in all runs.
- `node harness/prompt.mjs <app> <dir> <A|B>` prints the exact prompt of any app: A is the agent-alone prompt, and B is the with-perf-kit prompt. The first message in the transcript of each run is the same text.

## Method

1. `harness/prepare.mjs` copies the app to a work folder, installs it with bun and commits a baseline. In the perf-kit arm, it also adds the perf-kit tarball to the app.
2. The agent works in that folder with [the prompt](#the-prompt).
3. `harness/evaluate.mjs` applies the agent's commits to a clean copy without perf-kit, then runs the build, the tests and the typecheck. Every agent answer here passes. `harness/smoke.mjs` also compares the `wrangler dev` responses with the unchanged app: on 4 paths for agents-sandbox-coding-agent and supermemory, which have no tests, and on 8 paths for open-seo. The responses are the same.
4. `harness/score.mjs` measures each copy.

The score is the active CPU time in the profile of `wrangler check startup`, with V8 sampling every 100 µs. Each copy runs 7 times per pass, the passes alternate between the copies, and the score is the median of 3 pass medians. A sample counts for at most 3 sampling intervals: most profiles have no sample for 6 to 7 ms after the first idle sample, and wrangler charges that gap to the next sample, so a startup under 1 ms reads as either 0 or about 6 ms.

perf-kit is `packages/perf-kit` of rolldown at [`44e6629`](https://github.com/rolldown/rolldown/commit/44e6629acea39db99ccb86486f178a749b8cf669). Its Worker mode is not in an npm release yet. The open-seo run used that commit plus 3 fixes to the Worker lab: the report-mode check finds Rolldown through Vite (bun puts an older Rolldown at the app root), Miniflare gets a private, empty dev registry (the app binds a second Worker), and the lab does not follow redirects. Without the first two, perf-kit fails on this app. None of the 3 changes what the scan reports.

## Reproduce

Tested on macOS 26 on an Apple M3 Max, with Node 24.12 and Bun 1.4.

```sh
(cd harness && npm ci)

# Score the published answers of an app.
node harness/evaluate.mjs agents-sandbox-coding-agent base
node harness/evaluate.mjs agents-sandbox-coding-agent with-perf-kit --patch results/agents-sandbox-coding-agent/with-perf-kit.patch
W=../perf-kit-eval-work.noindex/score/agents-sandbox-coding-agent
node harness/score.mjs base=$W/base with-perf-kit=$W/with-perf-kit
```

To run an agent, pack perf-kit from a rolldown checkout (`cd packages/perf-kit && npm pack`), then:

```sh
node harness/prepare.mjs agents-sandbox-coding-agent ../work/sandbox-B --perf-kit <path to the .tgz>
node harness/prompt.mjs agents-sandbox-coding-agent ../work/sandbox-B B   # A: agent alone, B: with perf-kit
# Run the agent in ../work/sandbox-B with this prompt.
node harness/evaluate.mjs agents-sandbox-coding-agent my-run --from ../work/sandbox-B
```

Run one agent or one score at a time: parallel builds change the timings. Machine load moves the absolute numbers, so score the unchanged app and the answers in the same session, and compare the shares. `harness/startup-graph.mjs` lists the modules that each copy loads at startup. Machine load cannot change that list.

Work folders go to `../perf-kit-eval-work.noindex` (`PERF_KIT_EVAL_WORK` changes it). `evaluate` writes `<label>.patch` and `<label>.gate.json` to `answers/<app>/` in that folder.

## The apps

### agents-sandbox-coding-agent

The [`examples/sandbox-coding-agent`](https://github.com/cloudflare/agents/tree/361046e4f5f528540783d9078c438cb3cbe2d470/examples/sandbox-coding-agent) app of [cloudflare/agents](https://github.com/cloudflare/agents) (MIT) at `361046e`: an orchestrator agent that sends coding tasks to Claude Code sub-agents, each in its own Sandbox container. The orchestrator and the sub-agent are Durable Object classes, and so is the Sandbox.

- **With perf-kit** (`with-perf-kit.patch`, 2 files): the 3 Durable Object classes (`CodingOrchestrator`, `ClaudeCodeAgent` and `Sandbox`) and the `ContainerProxy` export move to a new module, `src/agents.ts`. `src/server.ts` keeps small wrappers with the same names that extend `DurableObject` or `WorkerEntrypoint`. A wrapper loads `src/agents.ts` on its first call and forwards each call to the real object through a Proxy. The agent router loads inside `fetch`.
- **Agent alone** (`agent-alone.patch`, 4 files): `CodingOrchestrator` no longer extends `Think` from `@cloudflare/think`. It extends `AIChatAgent` and runs its own chat loop with `streamText` of the AI SDK, with the 2 delegation tools and at most 10 steps. The Workers AI provider loads inside that loop. A build alias replaces `@modelcontextprotocol/client` with a new module whose classes load the real client on first use. The answer also turned on minification. The score leaves that change out, because minification lowers parse time for any app and does not show what the agent found. `agent-alone-with-minify.patch` is the full answer.

### open-seo

[every-app/open-seo](https://github.com/every-app/open-seo) (MIT) at `0c04886`: an open-source SEO tool, an alternative to Semrush and Ahrefs. Its main Worker serves a TanStack Start app, an MCP server and an AI chat agent, `SamChatAgent`: a Durable Object class that extends `Think` from `@cloudflare/think`. The Worker also exports 3 Workflow classes and runs cron jobs. The maintainers already keep a list of packages that must stay out of the startup graph, for the isolate's memory limit: `vite-plugin-lean-worker-bundle.ts` fails the build when one of them comes back through a static import.

- **With perf-kit** (`with-perf-kit.patch`, 11 files): `SamChatAgent` and the 3 Workflow classes become small wrappers that extend `DurableObject` or `WorkflowEntrypoint`, load their implementation on the first call and forward the call to it. Most lines of the patch move the class code to new `*Impl.ts` files. The TanStack Start handler, the agent router, the OAuth provider, the database and the cron jobs load on first use, and the auth mode check no longer imports zod.
- **Agent alone** (`agent-alone.patch`, 17 files): the TanStack Start handler, the OAuth provider, the database and the request and cron handlers load on first use. Inside `SamChatAgent`, the database, repository, billing and skill modules load when the object first needs them, and the Workflow classes load their services when they run. `SamChatAgent` itself stays in the main module, so Think, the agents SDK, the MCP client and the AI SDK still load at startup.

### supermemory

[supermemoryai/supermemory-mcp](https://github.com/supermemoryai/supermemory-mcp) (MIT) at `84f5dc9`: an MCP server that makes a user's memories available to any MCP client. Its README says that this version is being deprecated. The Worker serves a React Router app and sends the MCP connections to a Durable Object class, `MyDurableObject`, which runs a Hono server with muppet, zod and the supermemory SDK.

- **With perf-kit** (`with-perf-kit.patch`, 2 files): `MyDurableObject` becomes a small wrapper that extends `DurableObject`, loads its implementation from a new module on the first request and forwards `fetch` to it. The React Router handler loads on the first request.
- **Agent alone** (`agent-alone.patch`, 3 files): React Router, Hono, muppet and the supermemory SDK load on first use, in the request handler and inside `MyDurableObject`. New validators give muppet the JSON Schema of the MCP tools directly, and a build plugin stubs the JSON Schema adapters of `@standard-community/standard-json`, which the app then never uses. A build alias points `react-dom/server` at the streaming renderer only. These two build changes shrink the bundle from 5.9 MiB to 2.6 MiB. The answer also turned on minification, which the score leaves out, as for agents-sandbox-coding-agent. `agent-alone-with-minify.patch` is the full answer.

Both answers load 16 modules at startup, and their scores differ by 0.2 ms: a tie.

## Licenses

- `apps/agents-sandbox-coding-agent`: MIT, see [its LICENSE](apps/agents-sandbox-coding-agent/LICENSE). The changes from upstream are in [`sources/agents-sandbox-coding-agent.json`](sources/agents-sandbox-coding-agent.json).
- `apps/open-seo`: MIT, see [its LICENSE](apps/open-seo/LICENSE). The changes from upstream are in [`sources/open-seo.json`](sources/open-seo.json).
- `apps/supermemory`: MIT, see [its LICENSE](apps/supermemory/LICENSE). The changes from upstream are in [`sources/supermemory.json`](sources/supermemory.json) and [`sources/supermemory.patch`](sources/supermemory.patch).
- `results/<app>/*.patch` change those apps, under the license of the app.
- All other files: MIT, see [LICENSE](LICENSE).
