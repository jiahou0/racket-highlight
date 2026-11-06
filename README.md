# Racket Workbench

面向小型 Racket 程序和日常编辑的 VS Code 扩展，基于 Racket 官方 reader、expander、Check Syntax 和 `syntax-color`。提供高亮、补全、导航、重命名、结构编辑，以及原生终端运行和 REPL；不依赖其他 Racket 扩展或语言服务器。

## 安装

需要 VS Code 1.95 或更新版本，以及扩展运行环境中的 Racket。完整 Racket 发行版通常包含所需的 `drracket-tool-text-lib`、`syntax-color-lib` 和 `scribble-lib`。使用 Remote SSH、WSL 或容器时，Racket 需安装在远端。

1. 执行 **Extensions: Install from VSIX…**，选择 `releases/` 中的安装包。
2. 执行 **Developer: Reload Window**。
3. 打开 Racket 文件，在信任工作区后使用分析和运行功能。

默认通过 `racket` 命令启动，可用 `racketWorkbench.executable` 指定绝对路径。扩展不会自动安装 Racket 或其包。同一工作区建议只启用一个 Racket 扩展，避免功能冲突。

当前通过本地 VSIX 交付，未发布到 Marketplace，未授予开源许可证。

## 检查与编辑

| 时机 | 行为 |
| --- | --- |
| 打开文件 | 自动检查；内容相同且缓存有效时复用结果 |
| 编辑文件 | 不自动检查，撤销过期绑定和诊断，状态显示 `Unchecked` |
| 保存文件，包括自动保存 | 重新检查当前文件 |
| 检查进行中 | 显示 `Analyzing`，可通过状态栏或命令取消 |
| 模块检查成功 | 显示 `N bindings`，提供当前版本的语义功能 |
| 检查失败 | 显示 `Analysis failed`，报告错误，保留词法编辑功能 |
| 使用 `racket/load` | 显示 `Syntax`，提供基础语法编辑，不做 Check Syntax 绑定分析 |

点击状态栏可检查当前编辑器内容，无需保存；检查期间点击可取消。**Racket: Reanalyze Workspace** 检查所有已打开的 Racket 文件，不扫描整个项目。保存、磁盘文件变化和可执行文件配置变化会使其他分析缓存失效，但不会自动检查其他文件。

### 补全、导航与签名

- 当前检查成功时，按实际作用域补全标识符，提供定义跳转、引用、高亮和重命名。
- 编辑中或检查失败时，名称补全沿用上次成功检查的候选。它可能包含已删除或不在当前作用域内的名称；新定义和新导入在检查成功后更新。关闭文件会清除历史名称。
- 标准 Racket 的模块路径补全支持未闭合的 `require` 和常见导入包装形式，可补全集合路径、相对路径并逐层进入目录。包含转义或换行的路径不自动替换。
- 本地函数参数提示支持可选、关键字、剩余参数和 `case-lambda`；其他调用可显示已安装 Scribble 文档中的签名。参数提示需要当前版本成功检查。
- Outline 和面包屑显示定义及嵌套结构；分析失败时，Outline 只显示 reader 已读出的顶层结构。

悬停、补全、参数提示和大纲查询不会自行启动语义检查。需要当前绑定信息时，保存或执行 **Racket: Check Current File**。

词法编辑不需要等待完整展开。当前语义结果、历史补全名称和旧颜色分别管理；保留候选或颜色不代表当前文件已经检查成功。

### 高亮与格式化

词法着色使用当前文本，语义着色区分绑定、导入、宏、函数、参数与契约责任。函数和参数使用独立的正体颜色，可在 `workbench.colorCustomizations` 中设置：

- `racketWorkbench.functionForeground`
- `racketWorkbench.parameterForeground`

编辑时保留未受影响的旧颜色和未使用代码的灰淡效果，修改范围内的旧标记会移除；检查成功后更新。旧显示可能暂时不准确，不用于导航或重命名。灰淡效果遵循 `editor.showUnused`，过期诊断会清除。

默认启用 Racket 的 `editor.formatOnType`，回车时使用官方缩进。格式化保留跨行字符串等词法单元内部的内容。代码片段使用 `rkt-` 前缀，如 `rkt-fun`、`rkt-let` 和 `rkt-match`。

## 常用操作

以下命令均可在命令面板中搜索 `Racket:`。快捷键按 macOS 标注；其他平台将 Cmd 换成 Ctrl、Option 换成 Alt。

| 操作 | 命令（省略 `Racket:`） | 快捷键 |
| --- | --- | --- |
| 运行文件 | Run File in Terminal | `Cmd+Option+R` |
| 加载到 REPL | Load File in REPL | — |
| 求值选区或表达式 | Evaluate Selection or Expression | `Option+Enter` |
| 中断、停止、重启 REPL | Interrupt / Stop / Restart REPL | — |
| 检查当前文件 | Check Current File | `Cmd+Option+K` |
| 取消检查 | Cancel Current Check | `Cmd+Option+Shift+K` |
| 检查已打开文件 | Reanalyze Workspace | — |
| 整理重名定义 | Organize Duplicate Definitions | — |
| 打开本地文档 | Open Documentation | — |
| 查看语法关系 | Show Syntax Relations | — |
| 查看注解 JSON | Inspect Check Syntax Annotations | — |

编辑器标题栏提供加载 REPL、运行文件和整理重名定义按钮。跳转、引用、重命名使用 VS Code 标准语言命令。**Racket Relations** 默认跟随光标，标题栏按钮可切换到全文件。

### 运行与 REPL

两个入口都会先保存当前文件，再从磁盘加载依赖；依赖文件的修改也需先保存。

**Run File in Terminal** 执行 `racket 文件路径 参数…`，复用一个保留输出和历史的 shell 终端。macOS 使用 zsh，Linux 使用 bash，Windows 使用 PowerShell。运行依赖 VS Code shell integration；终端忙时拒绝提交新命令。

**Load File in REPL** 为每个文件启动独立的原生 Racket REPL，以 `enter!` 加载模块。再次加载会重启会话。求值前需完成加载并等待 REPL 接受输入；文件内容变化后需重新加载，撤销回加载时的内容后可继续求值。扩展不解析终端输出来判断加载是否成功。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `racketWorkbench.executable` | `racket` | 分析、运行和 REPL 使用的程序 |
| `racketWorkbench.arguments` | `[]` | 传给被运行程序的字符串参数 |
| `racketWorkbench.workingDirectory` | 空字符串 | 默认使用文件目录；相对路径也以文件目录为基准 |

工作目录决定 `(open-input-file "data.txt")` 等相对文件访问的位置，即使运行命令使用了源码的绝对路径也一样。

### 结构编辑

右键菜单 **Racket Structure** 和命令面板均提供结构操作。以下快捷键直接按下即可执行，无需前缀键。

| 快捷键 | 操作 |
| --- | --- |
| `Option+←` / `Option+→` | 移到前一个／后一个表达式 |
| `Option+↑` / `Option+↓` | 移到外层／进入内部 |
| `Option+S` | 选择表达式，重复按向外扩大 |
| `Option+Shift+←` / `Option+Shift+→` | 与前一个／后一个表达式交换 |
| `Option+Shift+↑` | 用当前表达式替换外层表达式（Raise） |
| `Cmd+Option+←` / `Cmd+Option+→` | 从左／右纳入表达式（Slurp） |
| `Cmd+Option+Shift+←` / `Cmd+Option+Shift+→` | 从左／右移出表达式（Barf） |
| `Option+P` / `Option+B` | 用圆括号／方括号包裹 |
| `Option+U` | 解包裹 |
| `Option+C` | 将列表括号改为 `()`、`[]` 或 `{}` |
| `Option+;` 或 `Cmd+Option+;` | 切换 `#;` 表达式注释 |
| `Option+Backspace` | 删除完整表达式 |

例如，光标在 `(f a)` 内时，Slurp Forward 将 `(f a) b` 改成 `(f a b)`，Barf Forward 将最后的 `b` 移出去。

这些按键在受信任工作区的 Racket 编辑器中生效，会覆盖对应的普通文本操作。导航和扩大选择操作主光标；结构修改支持多光标，并拒绝歧义或重叠的修改。可在键盘快捷方式设置中搜索 `Racket:` 调整绑定。

基于 reader 的结构修改支持 `#lang racket`、`racket/base` 和 `racket/load`，允许声明前有空白或标准注释。引用前缀与操作数一起处理；纳入、移出和解包裹仅处理普通列表。成功修改可一次撤销，不自动格式化或保存。

### 整理重名定义

**Organize Duplicate Definitions** 将同名顶层 `define` 的早期版本改为 `a0`、`a1`，最后一个保留 `a`，并调整能够确定的引用，避开已有名字。支持上述三种语言中的普通函数、直接递归和局部遮蔽。修改可一次撤销，不自动保存或更改 `#lang`。

这是教学代码的版本整理工具。遇到导入、自定义宏、旧值初始化、早期函数作为值传递或不明确的延迟引用时，整次操作拒绝修改。

源码仓库也提供逐文件直接写入的入口；它没有编辑器撤销，也不保证多文件整体成功：

```sh
racket backend/organize.rkt --write 文件…
```

## 能力边界

- 语义功能依赖完整展开。宏生成的源码位置或绑定不明确时，相关导航和修改可能不可用。
- 确认未导出的本文件定义，其引用与重命名只处理当前文件。跨文件重命名需要工作区；跨文件查询要求候选模块能完整分析，不搜索工作区之外的反向引用。操作期间编辑源码会取消结果。
- 工作区符号只列出有效缓存中的定义。显式跳转、引用和重命名可以按需检查目标文件。
- 分析通过模块加载器使用未保存的编辑器内容；宏直接读取磁盘时仍使用磁盘文件。外部状态变化可能需要手动重新分析。
- reader 和展开过程可以执行代码，因此分析要求工作区受信任。未信任时保留静态着色及基础语言配置。

扩展不提供调试器、宏展开查看器或源码箭头。

## 排查问题

在 **Output → Racket Workbench** 查看日志，在 **Problems** 查看有源码位置的错误。依赖文件的错误定位到依赖文件；无位置的错误保留在输出和状态中。

| 现象 | 处理方式 |
| --- | --- |
| 缺少新补全、跳转不可用或仍显示旧颜色 | 保存或检查当前文件；检查成功后更新 |
| 状态为 `Restricted` | 信任工作区后启用分析 |
| Racket 无法启动 | 查看日志，确认扩展运行环境中的 `racket`，或配置绝对路径 |
| 运行终端 busy | 等待程序结束，或在终端中中断程序 |
| shell integration 不可用 | 开启 `terminal.integrated.shellIntegration.enabled`，关闭运行终端后重试 |

## 构建与本地安装

需要 Node.js 20 或更新版本、npm 和 PATH 中的 `raco`；可用 `RACO` 环境变量指定构建程序。

在仓库根目录执行：

```sh
npm ci --ignore-scripts
node scripts/build.mjs --package
```

构建先重新生成 `dist/`，编译 TypeScript，再复制 Racket 后端源码并执行 `raco make`。打包版本取自 `package.json`，产物为 `releases/racket-workbench-<版本>.vsix` 及同名 `.sha256` 文件。

安装到本项目使用的 VS Code 配置：

```sh
version=$(node -p "require('./package.json').version")
code --profile 'Scheme/Racket' \
  --install-extension "$(pwd)/releases/racket-workbench-${version}.vsix" --force
```

安装后执行 **Developer: Reload Window**。`npm run build` 只构建；`npm run package` 构建并打包；`npm run clean` 只清理 `dist/`，不删除发行包。

VSIX 包含 JavaScript、Racket 后端源码和运行资源，不包含开发依赖、源码映射或本机 Racket 编译缓存。构建与打包不运行测试，测试和验收由项目所有者负责。

源码与安装包还包含以下文档：

- `docs/ARCHITECTURE.md`：模块职责、worker 协议、缓存生命周期与修改约束。
- `docs/CHECK_SYNTAX.md`：原生回调、扩展补充的信息与名称冲突请求。
- `CHANGELOG.md`：各版本的功能变化与代码整理。
