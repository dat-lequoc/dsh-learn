# dsh-learn

A guided-teaching mode for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Off by
default, turned on per session with `/learn`, and fully separate from normal
coding sessions — it never touches DSH source or
[dsh-better-sidebar](https://github.com/dat-lequoc/dsh-better-sidebar) source, and consumes only
dsh-better-sidebar's public plugin API.

## What it does

- `/learn [topic]` turns guided learning mode on for the current session; `/learn off` turns it
  off. This is a per-session, in-memory switch — it never changes any other session or any global
  setting.
- While active, the model is nudged (via a conditional system-prompt section) to teach one concept
  at a time and check understanding with a graded `quiz` tool instead of free-form questions.
- The `quiz` tool poses a multiple-choice comprehension check. The learner answers it in a
  dedicated **Learn** tab inside dsh-better-sidebar's native sidebar — never in the main chat
  composer — and gets immediate right/wrong feedback plus the model's explanation.
- The Learn tab also shows the session transcript (full Markdown, including Mermaid diagrams), a
  per-session notes field, and a compact composer so you can send a follow-up or interrupt the
  running turn without switching back to the main chat view (handy on a phone).

## Requirements

- DSH `^0.1.7-rc.1` or later.
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
