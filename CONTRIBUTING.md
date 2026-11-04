# Contributing to BookWeave / 贡献指南

English | [中文](#中文)

Thanks for taking the time to improve BookWeave. This project is a DSH Web client plugin: most of the logic lives in one browser module (`client/client.js`) plus a small Host half (`index.js`).

## Development setup

```sh
git clone https://github.com/adrianwang99/dsh-bookweave.git
cd dsh-bookweave
npm test        # node-only suites, no dependencies
npm run check   # syntax check both halves
```

Requirements: Node.js ≥ 20. The test suites are dependency-free and deterministic; they load `client/client.js` through the same `window.__ModuleLoader__` seam the DSH Web client uses.

Optional real-book smoke tests are skipped unless you provide EPUBs:

```sh
BOOKWEAVE_SMOKE_ZH=/path/to/zh.epub BOOKWEAVE_SMOKE_EN=/path/to/en.epub npm test
```

## Manual testing in DSH

1. Install the checkout as a local bundle (see [README](README.md#install)).
2. Restart DSH for Host changes (`index.js`); a page refresh is enough for client changes.
3. Check: import → reading → excerpts → guide (heuristic cards + AI) → book list search → export.

## Pull requests

- Keep changes focused; one feature or fix per PR.
- Update `CHANGELOG.md` for user-visible changes.
- Run `npm test` and `npm run check` before opening the PR.
- If you change the AI prompt or output shape, update `test/host.mjs` and both READMEs.
- Do not add runtime dependencies unless there is no reasonable alternative; the client is a single self-contained browser module.
- Respect the local-first design: no telemetry, no background network calls, cache AI results.

## Code style

- Plain ES modules, no build step, no TypeScript.
- Prefer small pure helpers in the `core` export so they can be unit-tested from Node.
- Keep UI strings in `locale/zh.json` and `locale/en.json`; never hard-code user-facing text in the client.
- Comments may be Chinese or English; user-facing copy must exist in both locales.

## Security & privacy

- Never commit API keys, tokens or personal data.
- Any model call must stay explicit (user button), chapter-scoped and cached.
- Report security issues privately rather than in a public issue.

## 中文

感谢改进书脉。这个项目是 DSH Web 客户端插件：主体是一个浏览器模块（`client/client.js`）加一个很小的 Host 半（`index.js`）。

开发流程：

```sh
git clone https://github.com/adrianwang99/dsh-bookweave.git
cd dsh-bookweave
npm test        # 纯 Node 测试，零依赖
npm run check   # 语法检查
```

- 需要 Node.js ≥ 20；测试不依赖浏览器/React/npm 包。
- 本地调试：把仓库作为本地 bundle 安装进 DSH；改 Host 需重启，改客户端刷新即可。
- 提交前请跑 `npm test` 与 `npm run check`，并在 `CHANGELOG.md` 记录用户可见变化。
- 面向用户的文案必须同时补 `locale/zh.json` 与 `locale/en.json`。
- 保持本地优先：不做遥测、不后台联网、模型结果必须缓存；模型调用必须由用户显式触发且只针对单章。
