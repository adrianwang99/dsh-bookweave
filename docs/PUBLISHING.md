# Publishing BookWeave / 发布指南

This document covers the four distribution paths for DSH plugins:

1. [GitHub repository + npm package](#1-github--npm)
2. [awesome-dsh-plugin (PR)](#2-awesome-dsh-plugin-pr)
3. [WhaleHub (Issue)](#3-whalehub-issue)
4. [deepseek.stream upload (zip)](#4-deepseekstream-upload-zip)

> The community markets are maintained by the community, not DeepSeek. Being listed is not an official security endorsement.

## Prerequisites / 前置条件

- Public GitHub repository with real, working code, `package.json`, `cordis.patch.yml`, `README`, `LICENSE` and tests.
- `package.json` declares the standard bundle manifest:

  ```jsonc
  {
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "platform": "web", "immediately": true }
    }
  }
  ```

- GitHub repository topic: `dsh-plugin`.
- A license (this repo uses MIT).
- `npm test` passes.

## 1. GitHub + npm

Create the repository and push:

```sh
git init
git add .
git commit -m "feat: initial public release"
gh repo create adrianwang99/dsh-bookweave --public --source=. --remote=origin --push
gh api -X PUT repos/adrianwang99/dsh-bookweave/topics -f names='["dsh-plugin","dsh","epub","reader","deepseek"]'
```

Create a GitHub release and attach the packed tarball (used by some marketplaces):

```sh
npm pack                       # -> dsh-bookweave-0.8.1.tgz
gh release create v0.8.1 dsh-bookweave-0.8.1.tgz --title "v0.8.1" --notes-file CHANGELOG.md
```

Publish to npm (requires your own npm login — the machine that generated this repo was **not** logged in):

```sh
npm login
npm publish --access public
```

After that, users install with:

```sh
dsh plugin add dsh-bookweave
```

## 2. awesome-dsh-plugin (PR)

Repository: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

- One YAML file per plugin: `data/plugins/<owner>__<repo>.yml`.
- A ready-to-copy file lives at [`marketplace/awesome-dsh-plugin/adrianwang99__dsh-bookweave.yml`](../marketplace/awesome-dsh-plugin/adrianwang99__dsh-bookweave.yml).
- Only `description.en` is required (ending with a period); `description.zh` is optional but provided.
- Valid categories include `ui`, `usage`, `docs`, `tools`, `workflow`, `memory`, `browser`, `fun` — this plugin uses `ui`.
- The repository must be **at least 1 day old** (CI-enforced), must have the `dsh-plugin` topic, and must declare `dsh.bundle`.

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cp marketplace/awesome-dsh-plugin/adrianwang99__dsh-bookweave.yml \
   awesome-dsh-plugin/data/plugins/adrianwang99__dsh-bookweave.yml
cd awesome-dsh-plugin
git checkout -b add-dsh-bookweave
git add data/plugins/adrianwang99__dsh-bookweave.yml
git commit -m "Add dsh-bookweave"
git push -u origin add-dsh-bookweave
gh pr create --title "Add dsh-bookweave" --body "EPUB reader + book-list + AI chapter guide for DSH."
```

## 3. WhaleHub (Issue)

Repository: <https://github.com/vvlife/whalehub-dsh>

Open the **提交插件** issue form:

<https://github.com/vvlife/whalehub-dsh/issues/new?template=submit-plugin.yml>

Fields:

| Field | Value |
| --- | --- |
| 仓库地址 | `https://github.com/adrianwang99/dsh-bookweave` |
| 分类 | `web-ui（界面与皮肤）` |
| 一句话描述 | EPUB 阅读器 + 引书书单 + AI 章节导览 |
| 安装方式 | `dsh plugin add dsh-bookweave` (or `github:adrianwang99/dsh-bookweave` before npm publish) |
| 注意事项 | Needs the DSH Web UI; AI analysis additionally needs the Host `llm` service (optional); restart DSH after installing. |

The form also asks you to confirm the repo is public with install instructions and contains no malicious code.

A ready-to-paste copy is at [`marketplace/whalehub/submission.md`](../marketplace/whalehub/submission.md).

## 4. deepseek.stream upload (zip)

<https://deepseek.stream/upload>

Pack the plugin folder (no `node_modules`, no `.git`):

```sh
cd /path/to/dsh-bookweave
rm -f ../dsh-bookweave-0.8.1.zip
zip -r ../dsh-bookweave-0.8.1.zip . \
  -x 'node_modules/*' -x '.git/*' -x '*.tgz'
```

Upload the zip (or paste the GitHub URL). The center parses the metadata and bundle manifest; it requires `plugin.json` in the package for the storefront metadata and `package.json` with `dsh.bundle` / `dsh.client`.

## Community market checklist / 社区市场检查清单

- [ ] Public repo, MIT license, README with install instructions
- [ ] `dsh-plugin` topic
- [ ] `dsh.bundle` + `cordis.patch.yml`
- [ ] Tests pass (`npm test`)
- [ ] Repository older than 1 day (for awesome-dsh-plugin)
- [ ] No secrets, no telemetry, no background model calls
- [ ] Descriptions are factual and match the code
