# 本地文件比较

一个运行在浏览器中的本地文件和目录比较工具。文件只在浏览器内读取，不上传、不保存，也不会写回原文件。

## 使用

环境要求：Node.js 16.18 或更高版本，以及桌面版 Chrome 或 Edge（浏览器测试支持 Chrome、Chromium 或 Edge）。

```sh
npm install
npm start
```

打开终端输出的本地地址，选择单文件或目录后，分别添加左右两侧输入并开始比较。目录比较按相对路径匹配文件；单文件比较会显示文本差异和忽略空白、换行符选项。内存自检期间暂时禁用这两个选项，结束后恢复。浏览器后退恢复页面后，可以继续比较原先选择的文件。

## 边界

- 每侧最多 20,000 个文件，合并路径可达 40,000 项；单侧超限时整体拒绝并提示，不截断、不生成逐项相同结论。文件选择阶段和比较核心均提前校验。
- 单文件最多 50 MiB。
- 文件按 1 MiB 分块读取，比较最多使用两路并发。
- 文本每侧最多 2 MiB、20,000 行，使用 UTF-8 或带 BOM 的 UTF-16LE/BE。少量分散修改有快速计算路径，复杂差异仍受 2,000,000 工作量预算约束，超限明确显示未比较。
- 目录选择无法表示空目录；读取失败、取消和超出预算都不会被判断为相同。

## 检查

```sh
npm run check
npm test
npm run test:browser
```

`npm run test:browser` 会启动独立临时浏览器配置，通过 DevTools 协议验证真实页面、Worker、CSP、取消流程及两次页面后退恢复，不会读取用户文件。

### 浏览器测试路径

浏览器测试支持 Chrome、Chromium 或 Edge，通过 `CHROME_PATH` 指定**可执行文件完整路径**，显式配置优先于自动探测；无效路径会报错，不会静默回退。

macOS / Linux：

```sh
CHROME_PATH="/path/to/chrome" npm run test:browser
```

Windows PowerShell：

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run test:browser
```

未配置时自动探测 macOS、Windows、Linux 的常见安装位置。测试始终使用独立临时配置目录，正常结束、失败和超时后关闭测试进程并清理目录，不使用日常浏览器配置。默认超时为 45 秒，可通过 `BROWSER_TEST_TIMEOUT_MS` 设置（100–120,000 毫秒）。

当前已实机验证 macOS arm64 / Chrome 150；Windows、Linux 仅完成路径选择逻辑测试，尚未实机验证。

### 性能复测

```sh
node scripts/benchmark-diff.js
```

脚本对相同、少量变化、远距离分散变化、完全不同、重复行和行数上限附近文本各测三次，并测量 40,000 路径目录取消的收尾耗时，输出工作量、进度次数、耗时和定时取消延迟。可选传入保存的核心模块目录，例如 `node scripts/benchmark-diff.js /path/to/baseline-core`，用相同输入测量基线。优化前后的原始样本及测量限制见 [性能记录](docs/performance.md)。这些 Node 测量不代表浏览器耗时。
