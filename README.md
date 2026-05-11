# JLPT 蓝宝书备考 Agent

本地静态网页应用，用你的蓝宝书 PDF 生成 N5-N1 文法条目计划，并根据当前水平、目标水平和每日备考时间同步每日完成情况。

## Run

推荐用本地 Node 代理启动，这样静态页面和 AI 接口同源，抽认卡里的 AI 例句拆解也可用：

```bash
npm run serve
```

然后打开 <http://localhost:5173>。

只使用计划、搜索和 PDF 阅读器等非 AI 功能时，也可以用静态服务启动：

```bash
npm run serve:static
```

静态 Python 服务没有 `/api/grammar-ai`，所以不能测试 AI。改动后可先跑：

```bash
npm run check
```

启动后可以在应用的「用户中心」选择 DeepSeek 或 MiniMax 并粘贴 API Key；卡片展开后会后台预缓存当前例句，单击日文词语优先直接显示句中解释，双击例句会分析整句。

也可以用环境变量启动：`DEEPSEEK_API_KEY="your_api_key_here" node server.mjs` 或 `MINIMAX_API_KEY="your_api_key_here" node server.mjs`。默认服务商是 DeepSeek，默认模型 `deepseek-v4-flash`，请求会显式关闭思考模式；MiniMax 默认模型是 `MiniMax-M2.7-highspeed`。可用 `AI_PROVIDER`、`DEEPSEEK_MODEL`、`MINIMAX_MODEL` 覆盖。AI 请求只发送句型名、日文例句、分词索引和后文窗口，不发送原书中文说明；预缓存会让 AI 一次返回整句拆解和各 token 的句中作用，AI 解释要求输出简体中文。

## AI Troubleshooting

- `missing_api_key`：在用户中心粘贴当前服务商的 API Key，或设置 `DEEPSEEK_API_KEY` / `MINIMAX_API_KEY` 后用 `node server.mjs` 启动。
- `auth_failed` / 401 / 403：检查 API Key 是否正确、是否属于当前服务商，以及账号是否可用。
- `rate_limited` / 429：服务商限流，稍后重试，或临时切换 provider / 模型。
- `endpoint_not_found` / 404 / 405：检查 Base URL；MiniMax 可在用户中心切换“国际接口 / 中国区接口 / 原生接口”。
- `network_error` / 502：检查本机网络、代理设置和 Base URL；AI 功能必须通过 Node 代理同源访问。
- `invalid_model_json`：模型没有按要求输出 JSON，点击“重新分析”；如果反复出现，换回默认快速模型。

如果你已经在 Chrome 登录 MOJi Test，建议用 Chrome 打开本地计划页；任务里的“打开 MOJi Test”按钮会复用同一个浏览器登录态。Safari 和 Chrome 的登录态不会互通。

## Local Materials

- 蓝宝书 PDF 放在 `public/materials/bluebooks/`。
- `*.pdf` 已加入 `.gitignore`，不会被提交。
- 词汇计划只记录每日数量，不内置词单；请在你的背词 app 中完成。
- 阅读/听力计划使用 MOJi Test 中的真题：按问卷目标级别安排年份、级别和板块，并提供打开 MOJi Test 网页端的按钮，不保存真题正文或音频。
- PDF 阅读和目录扫描使用本地 vendored `pdfjs-dist`，许可文件在 `public/vendor/pdfjs/`。
