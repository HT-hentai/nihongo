# N2 蓝宝书备考 Agent

本地静态网页应用，用你的蓝宝书 PDF 生成 N4/N3/N2 文法条目计划，并同步每日完成情况。

当前分支是 `codex/ai-study-assistant-experiment`，在本地静态版上增加 DeepSeek AI 学习助手实验功能。

## Run

```bash
python3 -m http.server 5173
```

然后打开 <http://localhost:5173>。

## DeepSeek AI Assistant

浏览器不会保存 DeepSeek API key。需要另开一个本地代理服务：

```bash
DEEPSEEK_API_KEY=你的key PORT=8788 node ai-proxy/index.mjs
```

也可以在本目录创建一个不会提交的 `.env`：

```bash
DEEPSEEK_API_KEY=你的key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
PORT=8788
```

然后直接运行：

```bash
node ai-proxy/index.mjs
```

可选环境变量：

- `DEEPSEEK_MODEL=deepseek-chat`
- `DEEPSEEK_BASE_URL=https://api.deepseek.com` 或 `https://api.deepseek.com/v1`

功能：

- PDF 阅读器会用 PDF.js 在浏览器 IndexedDB 建立本机文本索引；索引不提交、不导出。
- 选中 PDF 里的词或例句后，可让 AI 解释句中含义、语法点，并收藏进 AI 生词本。
- 今日文法任务可生成混合小测：选择题、填空题、造句题。
- 收藏项和低分小测会生成 `AI 生词/例句复习` 任务，加入原有滚动计划。

如果没有启动 8788 AI 代理，原本的本地计划、PDF 阅读、打卡和滚动调整仍然照常使用。

如果你已经在 Chrome 登录 MOJi Test，建议用 Chrome 打开本地计划页；任务里的“打开 MOJi Test”按钮会复用同一个浏览器登录态。Safari 和 Chrome 的登录态不会互通。

## Local Materials

- 蓝宝书 PDF 放在 `public/materials/bluebooks/`。
- `*.pdf` 已加入 `.gitignore`，不会被提交。
- 词汇计划只记录每日数量，不内置词单；请在你的背词 app 中完成。
- 阅读/听力计划使用 MOJi Test 中的真题：N3 2010-2024，N2 2010-2025；应用只记录年份、级别和板块，并提供打开 MOJi Test 网页端的按钮，不保存真题正文或音频。
- PDF 阅读和目录扫描使用本地 vendored `pdfjs-dist`，许可文件在 `public/vendor/pdfjs/`。
