# dsh-learn

A guided-teaching mode for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Off by
default, turned on per session with `/learn`, and fully separate from normal
coding sessions — it never touches DSH source or
[dsh-better-sidebar](https://github.com/dat-lequoc/dsh-better-sidebar) source, and consumes only
dsh-better-sidebar's public plugin API.

## What it does

- `/learn [topic]` turns guided learning mode on for the current session. With a topic, it also
  sends that topic to the model so the lesson starts right away (like `/plan <message>`).
  `/learn off` turns it off. This is a per-session, in-memory switch — it never changes any other
  session or any global setting, and it resets to off when DSH restarts.
- While active, the model is nudged (via a conditional system-prompt section) to teach one concept
  at a time and check understanding with a graded `quiz` tool instead of free-form questions.
- The **Learn** tab (inside dsh-better-sidebar's native sidebar) shows the lesson as one reading
  flow: your messages, the assistant's explanations (full Markdown, including Mermaid diagrams),
  and each quiz as a card right where it was asked. You answer a quiz in its card, never in the
  main chat composer, and the card then shows the right answer, your pick, and the explanation.
  Tool output and injected context stay in the main Chat view.
- Steer the lesson from the main chat input or the compact input at the bottom of the Learn tab—
  the latter keeps the full flow usable on a phone. A quiz never blocks: the `quiz` tool returns at once
  (so no tool or `run_code` timeout can expire while you think), and your graded answer reaches the model
  as your next message. The lesson only follows new content while you're at the bottom, so scrolling up
  to re-read is never interrupted.

## Requirements

- DSH `^0.2.0-rc.1` or later.
- [dsh-better-sidebar](https://github.com/dat-lequoc/dsh-better-sidebar) `>=0.19.0` installed in
  the same profile (optional peer — without it, dsh-learn's client half simply never activates;
  the `/learn` command and `quiz` tool still work, but there is nowhere to answer a quiz).

## Install

```sh
dsh plugin add dsh-learn
```

## Development

```sh
pnpm install
pnpm run build      # host lib + browser client bundle
pnpm run typecheck
pnpm test
```

## License

MIT
