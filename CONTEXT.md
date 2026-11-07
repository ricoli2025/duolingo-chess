# 项目上下文 / Session Context

本文件用于在多台电脑之间同步 Kimi Code 的对话上下文。每次会话结束时更新，另一台电脑上开始工作前请先阅读本文件。

---

## 2026-11-07 白底棋盘识别修复（MacBook，浏览器自动化环境）

### 用户诉求
Duolingo 白底（浅色主题）棋盘截图无法识别，要求用三张实测截图验证到每个棋子识别正确为止。

### 问题根源
1. 旧模板 `assets/piece-templates.json` 是**暗底棋盘**生成的（`offset=32`，假设棋子亮度围绕暗背景），白底棋盘上棋子比背景暗，偏差被不对称截断到 -32，特征被抹平 → 全部判空。
2. 模板只有 40px 且黑白棋子不分，浅色格上的白棋对比度低、互相混淆。

### 修改内容
- `js/recognition.js`
  - `cellFeatures` 截断范围改为对称 `±(255-offset)`；
  - 模板匹配改为**零均值归一化互相关**（`MIN_PIECE_CORRELATION = 0.4`），粗筛前 4 名后 ±2px 平移精搜；
  - 棋子颜色由**棋子像素绝对亮度**判定（`WHITE_PIECE_LUMA = 140`），不再依赖与背景的相对比较；
  - 置信度按棋子覆盖率打折（`coverage = occupied/2`），全识别失败不再虚高；
  - 模板 URL 加 `?v=2` 防缓存。
- `assets/piece-templates.json`：用三张截图共 65 个已知棋子样本重新生成（56px、offset=128、黑白分开）。旧模板备份在 `assets/piece-templates.dark.json.bak`。
- `index.html` 版本号 v10 → **v11**；`sw.js` 缓存 v10 → v11。
- `test/` 新增回归测试：`index.html`（逐格比对，三张图全部 ALL PASS）、`gen.html`（模板生成器）、`test/images/`（三张测试截图）。

### 关键坑（以后注意）
- 本机（MacBook）**没有 git/python3/node**，git 是未安装 CLT 的占位符；跑 JS 靠本地 HTTP 服务（`ruby -run -e httpd . -p 端口`）+ 内置浏览器。
- 浏览器会**缓存旧模板/旧 JS**：测试时必须给 URL 加版本参数或换端口，否则改完代码结果不变（曾因此误判修复无效）。
- 生成模板的标注里 puzzle 图 **c5 是白象不是马**（曾误标为马导致模板污染、马全部识别失败）。
- 测试页通过 Service Worker 缓存，强刷（Cmd+Shift+R）才能拿到新文件。

### 待办 / 建议
- 这台电脑建议安装 Xcode 命令行工具（`xcode-select --install`）恢复 git。
- 用户设备上已安装的 PWA 需强刷一次才会从 v10 缓存切到 v11。

---

## 使用说明（给两台电脑上的 Kimi Code）

- **开始工作前**：读这个文件，了解最近会话结论。
- **结束工作时**：把本次会话做了什么、关键决策、踩的坑追加到文件顶部（新的日期段落），并 commit/push。
- 对话的逐字记录仍在各电脑本地 `~/.kimi-code/sessions/`，本文件只保存结论性上下文。
