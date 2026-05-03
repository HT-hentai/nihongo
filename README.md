# N2 蓝宝书备考 Agent

本地静态网页应用，用你的蓝宝书 PDF 生成 N4/N3/N2 文法条目计划，并同步每日完成情况。

## Run

```bash
python3 -m http.server 5173
```

然后打开 <http://localhost:5173>。

如果你已经在 Chrome 登录 MOJi Test，建议用 Chrome 打开本地计划页；任务里的“打开 MOJi Test”按钮会复用同一个浏览器登录态。Safari 和 Chrome 的登录态不会互通。

## Local Materials

- 蓝宝书 PDF 放在 `public/materials/bluebooks/`。
- `*.pdf` 已加入 `.gitignore`，不会被提交。
- 词汇计划只记录每日数量，不内置词单；请在你的背词 app 中完成。
- 阅读/听力计划使用 MOJi Test 中的真题：N3 2010-2024，N2 2010-2025；应用只记录年份、级别和板块，并提供打开 MOJi Test 网页端的按钮，不保存真题正文或音频。
- PDF 阅读和目录扫描使用本地 vendored `pdfjs-dist`，许可文件在 `public/vendor/pdfjs/`。
