# Deftly Put

Deftly Put 是一款适用于 macOS 桌面版 Google Chrome 的 X 写作扩展。在发帖框或回复框中用熟悉的语言写下草稿，点击「翻译」，译文会填回编辑框，下方会显示回译供你核对。你可以继续修改，最后由你点击 X 的发布按钮。

## 安装

1. 将仓库下载到 Mac 上的固定位置。如果下载的是 ZIP，先完整解压。安装需要系统提供的 `/usr/bin/python3` 和 `/usr/bin/openssl`。
2. 在访达中打开 `Deftly-Put` 文件夹，双击 `安装本机助手.command`。此脚本为当前 macOS 用户安装助手，并将其注册到 Chrome。
3. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择含有 `manifest.json` 的 `Deftly-Put/extension` 文件夹。
4. 从 Chrome 工具栏打开 Deftly Put，点击「Continue with ChatGPT」，在 OpenAI 页面登录并授权使用 ChatGPT 套餐。扩展显示「已连接 ChatGPT 套餐」后，刷新已打开的 X 页面即可使用。

## 选择语言

在扩展弹窗的「翻译设置」中选择默认源语言和目标语言，点击「保存语言设置」。源语言初始取安装时 Chrome 的界面语言，也是显示回译时使用的语言。默认目标语言初始为英语。

自己发帖时，扩展使用默认目标语言。回复时，扩展优先跟随原帖语言。要为当前草稿指定语言或调整语气，点击「翻译」旁的三角形。更多操作见[使用说明](Deftly-Put/使用说明.txt)。

## 数据与隐私

点击「翻译」会使用已授权的 ChatGPT 套餐额度。本机助手将草稿和翻译设置发给 OpenAI。回复时还会发送被回复的帖子，以及可读取的上游对话和引用帖节选，其中可能包含作者标识。页面缺少上文时，扩展可读取同一 Chrome 窗口中已打开的对应详情页，助手也可能向 X 请求公开帖子。

回译会将实际译文和本次源语言单独发给 OpenAI。手动微调译文后，扩展也会对修改后的文字请求回译。默认语言保存在本机 Chrome 中。为识别切换帖子时被 X 带入的旧译文，扩展按标签页在浏览器会话中暂存译文指纹、长度和原帖标识，关闭标签页后清除。

OpenAI 授权在浏览器中完成。助手通过本机临时回调端口接收授权结果，凭据保存在当前 macOS 用户的 `~/Library/Application Support/XReplyTranslator/account/` 目录。你可以在扩展菜单退出账号，也可以在 ChatGPT 的应用连接设置中撤销授权。

## 卸载

先在扩展弹窗中退出账号，再到 `chrome://extensions` 移除 Deftly Put。要一并移除本机助手与该用户的本地凭据，可在访达中按 ⇧⌘G 前往下列位置，将对应文件和目录移到废纸篓。

- Chrome 注册文件为 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.xreply.translator.json`。
- 助手程序和账号数据目录为 `~/Library/Application Support/XReplyTranslator/`。

## 开发验证

开发验证需要 Node.js 20 或更新版本、npm 和 Python 3。在仓库根目录安装锁定版本的开发依赖和 Chromium 无头测试引擎，再运行测试与打包。

```sh
npm ci
npx playwright-core install chromium --only-shell
npm test
npm run build
```

`npm test` 运行单元测试和浏览器回归测试。`npm run build` 生成包含项目许可证的 `Deftly-Put.zip`，核对包内文件与源码，并检查安装脚本的执行权限。

## 许可

Deftly Put 采用 GNU 通用公共许可证第 3 版（`GPL-3.0-only`）。[许可证全文](LICENSE)

第三方开发依赖各自适用其上游许可证。React、React DOM 和 Draft.js 使用 MIT，Immutable.js 使用 BSD-3-Clause，Playwright Core 使用 Apache-2.0。具体条款见各依赖包随附的许可文件。
