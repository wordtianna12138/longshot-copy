# 开发与打包

扩展没有第三方运行依赖或构建步骤，修改 `longshot-copy/` 后在 Chrome 扩展管理页重新加载即可。保持 `manifest.json` 的版本号与 `capture.js` 的安装标记一致。

## 项目结构

```text
longshot-copy/       Chrome 可直接加载的扩展
tests/              几何测试与独立浏览器验证
tools/              Python 打包工具
docs/               开发与版本说明
LICENSE             MIT 许可证
dist/               自动生成的 ZIP，不提交到源码仓库
```

`background.js` 调度截图与复制；`capture.js` 测量和恢复网页；`offscreen.js` 负责 PNG、拼接及进度面板；`geometry.js` 处理尺寸和拼接坐标。

## 测试

需要 Node.js 22 或以上。几何测试不需要安装依赖：

```sh
npm test
```

浏览器测试另外需要本机 Chrome，以及开发依赖：

```sh
npm install
npm run test:browser
```

默认使用系统安装的 Chrome，也可用 `CHROME_PATH` 指定可执行文件。当前脚本使用 Chrome 的扩展调试接口，验证环境为 Chrome 157；不要把测试工具的浏览器要求与扩展声明的最低版本 116 混淆。

下面的环境变量写法适用于 macOS / Linux：

```sh
LONGSHOT_HEADED=1 npm run test:browser
LONGSHOT_MODE=scroll npm run test:browser
LONGSHOT_DPR=2 LONGSHOT_CASES=normal npm run test:browser
LONGSHOT_LEGACY=1 LONGSHOT_CASES=normal npm run test:browser
```

测试使用临时浏览器配置和本机示例网页，不修改日常 Chrome 配置，但会**写入实际系统剪贴板**。真实窗口测试需要保持测试窗口在前台，才可验证 Mac 的面板焦点。测试图片写入已忽略的 `tests/results/`。

`LONGSHOT_EXTENSION_DIR` 可指定解压后的扩展包以验证最终产物。滚动模式测试仅在临时副本中切换工具栏入口；原始文件不变。`LONGSHOT_LEGACY=1` 在新版 Chrome 上模拟旧版复制分支，不代表真实旧版浏览器测试。

## 打包

需要 Python 3.9 或以上，不需要 Python 第三方依赖：

```sh
python3 tools/package-release.py
```

Windows 可使用 `python tools/package-release.py`。工具会生成：

- `dist/longshot-copy-版本号.zip`：供用户解压安装的扩展，包含安装说明和许可证。
- `dist/longshot-copy-版本号-source.zip`：可解压后上传 GitHub 的源码，包括根目录 README、许可证、测试和打包工具。
- `dist/SHA256SUMS.txt`：上述两个 ZIP 的校验值。

打包使用明确的文件清单，排除系统附加文件、测试输出、依赖目录、本地配置和其他压缩包。扩展 ZIP 根目录有 `manifest.json`；源码 ZIP 的扩展位于 `longshot-copy/` 子目录。未选择的文件不会自动被打包，新增必需源码时应同步更新清单。

不要把 `dist/` 上传到源码目录。下载用的扩展 ZIP 和校验文件可作为 GitHub Release 的附件；`docs/RELEASE.md` 可用于版本描述。许可证原文依据 [MIT License](https://choosealicense.com/licenses/mit/)。

## 已完成的 1.0.0 功能验证

macOS / Chrome 157：普通长页、宽页、短页、原生懒加载图片、内部滚动区、动态追加及顶部插入内容、双倍像素输出、取消、复制失败、切换窗口／标签页。验证内容包括 PNG 剪贴板、完整像素行、页面恢复、无结果新标签页及调试连接释放。5 项几何测试通过。

普通长页原生截图曾测得约 0.27 秒，滚动兼容模式约 3.22 秒；仅限本机示例，不是对所有页面的速度承诺。成功提示约 0.76–0.81 秒关闭。

Windows、Linux 和真实旧版 Chrome 尚未实机验证。默认模式不主动滚动，但不会隐藏 Chrome 自身的调试提示。
