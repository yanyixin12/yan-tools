# 让 AI agent 操作 Windows 桌面：UIA + 截图 + 输入，一个 PowerShell 脚本搞定

> 适用场景：需要在 Windows 上让 agent 点击按钮、读窗口文字、截图。不需要装 Python 库，不需要模拟键鼠框架，一个 PowerShell 脚本即可。

## 总体思路

Windows 自带了完整的桌面自动化 API，只是比较分散：

| 能力 | API | 说明 |
|---|---|---|
| 读控件树 | UI Automation（`UIAutomationClient`） | 能拿到控件的名字、类型、位置、值 |
| 截图 | `PrintWindow` / `CopyFromScreen` | PrintWindow 能截被遮挡的窗口 |
| 鼠标点击 | `SendInput` / `SetCursorPos` | 用绝对坐标 |
| 键盘输入 | `SendInput` + `KEYEVENTF_UNICODE` | 能输入任意 Unicode 文本 |

PowerShell 里用 `Add-Type -AssemblyName UIAutomationClient` 就能直接用 UIA，不需要装任何东西。

## 三个关键坑

### 1. Chromium/Electron 的 UIA 树是空的

用 UIA 遍历普通 Win32 程序（记事本、资源管理器）能拿到完整的控件树。但 Chromium/Electron 应用（VS Code、微信、WorkBuddy）默认只暴露一个节点：`Chrome Legacy Window`。

两个解法：

- 启动应用时加 `--force-renderer-accessibility`（Chromium 会为辅助技术构建完整树）
- 或者走 CDP（Electron 支持 `--remote-debugging-port`），直接操作 DOM，比 UIA 更稳

### 2. 截图截到的是遮挡后的画面

`Graphics.CopyFromScreen` 截的是屏幕可见区域。如果目标窗口被其他窗口挡住，你截到的是上层窗口。

用 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` 直接让窗口自己渲染内容，不受遮挡影响：

```powershell
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[GInput]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$bmp.Save($path)
```

### 3. Electron 应用被 `ELECTRON_RUN_AS_NODE=1` 坑死

如果启动 Electron 应用的环境里带 `ELECTRON_RUN_AS_NODE=1`（某些工具链会给子进程塞这个变量），应用会被当成 Node 进程运行：无参数时秒退（exit 0），带参数时报 `bad option`（exit 9）。

启动前必须清掉：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process "C:\path\app.exe"
```

## 脚本用法

把 UIA、截图、输入封装成一个脚本 `gui.ps1`：

```powershell
.\gui.ps1 windows                         # 列出可见窗口（标题、pid、坐标）
.\gui.ps1 tree "窗口标题" -Depth 4         # 读 UIA 控件树
.\gui.ps1 shot -Window "窗口标题" -Out x.png   # 截窗口内容（PrintWindow）
.\gui.ps1 click -X 100 -Y 200            # 点击屏幕坐标
.\gui.ps1 click -Window "标题" -Name "按钮名"  # 按控件名点击
.\gui.ps1 type "文字"                     # 输入 Unicode 文本
.\gui.ps1 key CTRL+S                     # 发送按键组合
```

## 一个实战配合：CDP

对于 Electron 应用，与其用 UIA 读界面，不如开 CDP：

```powershell
$env:WORKBUDDY_REMOTE_DEBUGGING_PORT = "9222"
Start-Process "D:\path\to\WorkBuddy.exe"
```

然后：

```javascript
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
// Runtime.evaluate 直接读写 DOM
```

DOM 级操作比 UIA 稳得多：不用坐标、不受遮挡、能直接拿文本。Slate 编辑器这类富文本输入框要注意，`execCommand('insertText')` 之后 React 状态不同步，要用 CDP 的 `Input.insertText`。

## 边界

- UIA 对 Chromium 需要特殊启动参数，对 Qt 程序（如网易 UU 远程）只暴露部分控件
- 截图用 PrintWindow 对某些 GPU 渲染的窗口可能黑屏，要回退到 CopyFromScreen
- 输入是全局的（焦点窗口收到），操作前要先激活目标窗口
- 这些 API 需要进程能访问用户桌面（在沙箱/服务里跑会失败）
