<div align="center">
  <img src="icon.svg" width="72" height="72" alt="书脉图标" />
  <h1>书脉 · BookWeave</h1>
  <p><strong>在 DSH 左侧栏里读 EPUB，自动发现书里提到的每一本书，再用 AI 生成可点击的章节导览。</strong></p>
  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green" /></a>
    <img alt="Version" src="https://img.shields.io/badge/version-0.20.0-blue" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-DSH%20Web-7c5cff" />
  </p>
  <p><a href="README.md">English</a> | 中文</p>
</div>

书脉是一个 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) **Web 客户端插件**。它把侧边栏变成 EPUB 阅读工作区：书架、沉浸阅读器、摘录、全书「引书书单」，以及一个 AI 辅助的**书籍导览**——总结当前章节，把观点和论据变成可点击的卡片，并始终能追溯到原文段落。

> 全部本地优先：EPUB、摘录、阅读进度和 AI 结果都存在浏览器 IndexedDB 里。唯一的网络请求是可选的「AI 提炼本章」，发给你在 DSH 里配置好的模型服务。

## 功能

| | |
| --- | --- |
| **双栏书架** | 书架左侧是书籍列表，右侧是「最近摘录和想法」面板：汇总**所有书籍**的摘录与想法，使用双列卡片布局、按时间倒序；点卡片会打开对应书籍并跳到相应章节。 |
| **书架与文件夹导入** | 左侧分类栏（新建 / 重命名 / 删除），每本书封面上的分类选择器；「导入文件夹」会递归导入所选文件夹下的全部 EPUB（自动跳过重复书），并放进当前分类；普通 `.epub` 文件和解压后的 `.epub` 文件夹（含 `META-INF/container.xml`）都能识别。 |
| **书架** | 点选或拖拽导入 `.epub`；从 EPUB 内嵌封面显示 2:3 竖版封面；卡片只保留书名、作者和阅读百分比。 |
| **阅读器** | 衬线排版、字号调节、图标式划词工具栏（悬停显示功能名）、按 NCX/nav 目录边界生成的目录（Calibre 拆分的多文件会并入同一章，分部有标记）、章节翻页、记住进度；无固定顶栏，阅读区和右侧栏都顶到窗口顶部。 |
| **书单** | 提取全书提及的书：《》书名、英文引号书名线索和词库，并过滤自引用、目录、章节标题、期刊等噪声；每条都能定位回出现段落。 |
| **摘录和想法** | 划词 → 红色下划线 + 摘录卡片，可加笔记；摘录和想法统一使用同一种操作卡片：徽标、章节/时间、正文，以及常驻的定位 / 笔记（摘录）/ 编辑 / 删除按钮。添加想法后会自动把对应原文和想法收进列表（旧想法没有存原文时，回退到当前段落文本）；「定位正文」改成按钮样式；列表内文字用系统字体（手写体只保留在右侧边注）。 |
| **边注想法** | 阅读区变窄，右侧留出的空白用来展示你的想法，**手写体**呈现，和对应段落/摘录对齐；每条想法可选 6 种墨色；展开想法时，对应正文会用**同色虚线**标出原文（卡片里不再重复引用原文）。划词工具栏或段右侧的「+」都能写。顶部悬浮条可**折叠/展开想法**（带动效）；折叠后有想法的段落右侧显示一条与想法同色的竖线，点竖线即可重新展开。 |
| **书籍导览** | 右栏 tab（在「摘录」左边）：打开时默认定位到你正在读的章节，并跟随目录/上一章/下一章/定位跳转。章节切换、AI 生成的本章总结、**按原文出现顺序**排列的导览卡片。观点会画成**论证链**：顶部是结论，中间一个向上的「因为」箭头，下面是原因/例子/数据等论据，每条都带关系标签；所有节点都附「原文」摘要，悬停高亮正文来源，点击定位并闪烁标出段落。 |
| **AI 提炼** | 每章一个显式按钮。小说 → 用原文文风写情节概括 + 情节节点；论述类 → 观点 + 论据。输入压缩到 ≤6–8k 字，输出 ≤700 tokens，推理取最低档，结果按书+章缓存；只有点「重新提炼」才会再次消耗。 |
| **翻译** | 打开「翻译」面板，下拉选择目标语言，点 **开始翻译** 才会开始（不会自动翻译）；译文会**写入书籍、作为正文显示在每段原文下方**，重开书仍在。**停止翻译**可中止，已译段落保留；面板显示进度条和「已翻译 X/Y 段」；翻译时正文高斯模糊并显示进度遮罩（完成后回来即可）。任务在书架层运行，退出书籍后会继续后台翻译，书架底部显示后台进度。分批、去重、跳过已是目标语言/已翻译的段落；模型输出异常会自动重试并拆小批次。 |
| **书籍搜索** | 书单条目可打开插件内浏览器面板（已填好搜索地址），或外部打开。搜索地址**可配置**（默认 Open Library），在书单 →「搜索源」里改模板，用 `{query}` 代表书名。 |
| **导出** | 把整本书单导出为 Markdown。 |
| **双语** | 中文 / English 界面。 |

## 安装

**要求** —— 带 Web UI 的 DeepSeek Harness。AI 部分额外需要 Host 的 `llm` 服务（DSH 已能调用的任意模型供应商）；没有它，阅读、摘录、书单和启发式导览仍然可用。

### 从 GitHub 安装（现在就能用）

```sh
dsh plugin add github:adrianwang99/dsh-bookweave
```

### 从 npm 安装（首次发布后）

```sh
dsh plugin add dsh-bookweave
```

### 从源码安装（开发用）

```sh
git clone https://github.com/adrianwang99/dsh-bookweave.git
cd dsh-bookweave
dsh plugin add .
```

或者手动把 checkout 链接进 profile，并在 profile 的 `package.json` 里加 `link:` 依赖：

```sh
ln -s "$(pwd)" ~/.dsh/profiles/desktop/node_modules/dsh-bookweave
```

安装或更新 **Host 半**（`index.js`）后需要重启 DSH（macOS ⌘Q）；只改客户端时刷新页面即可。

> 包遵循标准 bundle 清单：

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

## 使用

1. 从 DSH 侧边栏打开 **书脉**。
2. 导入 EPUB（点书架或把文件拖进窗口）。
3. 阅读：悬浮胶囊（← 书架、目录、右栏开关、A−/A+、导出）始终可用但不占布局高度。
4. 打开右侧栏 → 默认是 **导览**。选章节，需要时点 **AI 提炼本章**。
5. 悬停导览卡片 → 正文对应段落高亮；点击 → 滚动定位并闪烁标出。
6. 在正文划词 → 生成摘录（**摘录和想法** tab）或想法（右侧**边注**，手写体）；想法会自动带着原文一起出现在「摘录和想法」里，并按书 + 章节 + 段落持久保存。
8. 翻译：点悬浮「翻译」→ 下拉选目标语言 → 点「开始翻译」；面板显示进度，已译段落写入书籍正文并显示在原文下方；点「停止翻译」可中止，重开书译文仍在。
9. 书单 → 展开条目可定位原文，或在插件内浏览器里搜索这本书。搜索地址可配置（书单 →「搜索源」，默认 Open Library）。

> **目录说明** —— 章节现在按 EPUB 的 NCX/nav 目录边界生成，不再「一个 spine 文件一章」。**v0.17 之前导入的书**保存的是旧解析结果，删掉这本书重新导入一次即可使用新目录。

## AI 与隐私

- **只在点击时调用模型**：开书、切章节、切 tab 都不花钱。
- **小请求**：单章压缩摘录（客户端 ≤6,000 字，Host 兜底 8,000），输出短 JSON（≤700 tokens），推理取模型支持的最低档，不重试。
- **缓存**：按「书 + 章 + 内容指纹」存进 IndexedDB；重开同一章显示「已缓存」，不扣费；只有「重新提炼」才会再次调用。
- **无遥测**：唯一的网络请求是 `POST /api/dsh-bookweave/analyze`，发给自己这台 DSH 的 Host，再由 Host 转发给你配置的模型服务。
- **模型覆盖**：启动 DSH 前设置 `DSH_BOOKWEAVE_MODEL=provider/model`，可固定使用更便宜的模型。

## 数据存储

IndexedDB 数据库 `dsh-bookweave`（version 3）：`books`、`index`、`excerpts`、`insights`。
删除一本书会同时删掉它的正文、书单、摘录和 AI 结果；除可选的模型请求外，数据不离开本机。

## 开发

```sh
git clone https://github.com/adrianwang99/dsh-bookweave.git
cd dsh-bookweave
npm test          # 核心 + 归档 + 结构 + Host 四套测试（纯 Node，零依赖）
npm run check     # 客户端与 Host 语法检查
```

测试直接跑在 Node（≥20）里，不需要浏览器、React 或 npm 依赖：通过和 DSH Web 客户端相同的 `window.__ModuleLoader__` 接缝加载 `client/client.js`，测试 `plugin.core` 导出；Host 侧用假 LLM 流测试 AI 接口。详见 [`test/README.md`](test/README.md)。

可选的真实书冒烟测试默认跳过，给环境变量才跑：

```sh
BOOKWEAVE_SMOKE_ZH=/path/to/zh.epub BOOKWEAVE_SMOKE_EN=/path/to/en.epub npm test
```

### 目录结构

```text
.
├── client/client.js        # 全部 UI + core（EPUB 解析、书单提取、导览、AI 客户端）
├── index.js                # Host 半：/api/dsh-bookweave/analyze（调模型、prompt、结果收敛）
├── cordis.patch.yml        # bundle patch：注册插件行
├── locale/{zh,en}.json     # 插件元数据文案
├── icon.svg                # 侧边栏图标
├── plugin.json             # 市场元数据（deepseek.stream 上传用）
├── test/                   # 纯 Node 测试 + 合成 EPUB 夹具
├── docs/PUBLISHING.md      # npm / awesome-dsh-plugin / WhaleHub / deepseek.stream 发布指南
└── marketplace/            # 可直接提交的社区市场条目
```

## 已知限制

- EPUB 解析是容错的纯 JS 实现；损坏的 EPUB 会走轻量归档发现路径，DRM 文件不支持。
- 书单提取是启发式的，偏向召回，可能包含本书书名或章节标题；书单界面会标注，导出时不计入「找到的书」。
- AI 导览按章生成且为控制成本做了截断，不是整本书的精读。
- 插件内浏览器无法向跨域页面注入文字，所以用搜索 URL 打开。
- AI 结果取决于你配置的模型；弱模型可能提炼得一般，缓存结果不会被静默替换。

## 许可证

[MIT](LICENSE) © 2025 adrianwang99
