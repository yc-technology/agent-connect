# @yc-tech/telegramify-markdown

Convert Markdown into formats Telegram understands:

- **Plain text + `MessageEntity[]`** — via `convert()`, ready for the entities API
- **MarkdownV2 string** — via `markdownify()` (default export), with all the escaping the Bot API requires
- **Full pipeline** — `telegramify()` returns segmented `TelegramContent` (text / photo / file) for richer flows

Built on `unified` + `remark-parse` + `remark-gfm` + `remark-math`. Used by [Agent Connect](https://github.com/yc-technology/agent-connect) to render Claude Code / Codex transcript output into Telegram messages.

## Install

```bash
npm install @yc-tech/telegramify-markdown
```

## Usage

```ts
import telegramifyMarkdown, {
  convert,
  markdownify,
  telegramify
} from "@yc-tech/telegramify-markdown";

// Plain text + MessageEntity[] (for sendMessage with `entities`)
const [text, entities] = convert("**hi** `code`");

// MarkdownV2 string (for sendMessage with parse_mode: "MarkdownV2")
const mdv2 = markdownify("hello (world)");      // same as default export
const mdv2Alt = telegramifyMarkdown("hello (world)");

// Async pipeline returning segmented Telegram content
const segments = await telegramify("# title\n\n```js\nconsole.log(1)\n```");
```

Other helpers exported from the root: `splitMarkdownV2`, `escapeMarkdownV2`, `escapeCode`, `escapeUrl`, `entitiesToMarkdownV2`, `processMarkdown`, plus snake_case aliases of each.

See `dist/index.d.mts` for the full surface and types.

## License

MIT — see [LICENSE](./LICENSE).
