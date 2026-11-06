# Check Syntax 接入

语义后端基于 `drracket/check-syntax` 的 `annotations-mixin`，在完整展开后收集以下回调。本文描述当前代码的接入范围，不表示已经进行运行验收。使用方式见 [README](../README.md)，会话与绑定处理见[架构](ARCHITECTURE.md)。

## 原生回调

| 回调 | 用途 |
| --- | --- |
| `syncheck:find-source-object` | 统一源码身份，保存 identifier syntax 对象以恢复定义 phase |
| `syncheck:add-arrow/name-dup/pxpy` | 收集绑定两端、几何锚点、actual、phase 和 require 信息；保留名称冲突闭包供重命名调用 |
| `syncheck:add-tail-arrow` | 在关系树与注解快照中展示尾位置及两端导航 |
| `syncheck:color-range` | 语义着色，保留原生样式名 |
| `syncheck:add-text-type` | 分类元数据与光标位置的背景装饰 |
| `syncheck:add-mouse-over-status` | 悬停文本与消息列表 |
| `syncheck:add-require-open-menu` | 模块跳转与导入来源 |
| `syncheck:add-docs-menu` | 文档路径、锚点和标签；悬停及签名按需查询 Scribble 蓝框 |
| `syncheck:add-jump-to-definition/phase-level+space` | 跨文件跳转身份，保留导入 phase / space 并恢复定义 phase |
| `syncheck:add-definition-target/phase-level+space` | 定义目标、子模块身份与符号列表 |
| `syncheck:unused-binder` | 未使用绑定诊断、灰淡显示及无引用绑定的重命名入口 |
| `syncheck:add-unused-require` | 未使用导入诊断与灰淡显示 |
| `syncheck:add-prefixed-require-reference` | 导入前缀的源码位置、关系与重命名 |

未单独接入的历史回调沿用 `annotations-mixin` 的默认实现。未使用的导入不会自动删除，因为导入可能具有展开或运行副作用。

### 样式与展示

原生样式映射为独立 semantic token：lexically-bound、imported、free-variable、set!d，以及 my / their / both / unknown contract obligation。声明使用更具体的主题选择器；未知样式仅保留在注解中。`set!d` 表示绑定被赋值，不能据此把所有引用都标为写入。

**Racket: Inspect Check Syntax Annotations** 提供当前分析的 JSON 快照，包含文档 URI、版本、完整标记、错误、注解、分析时的依赖和补全问题。后续请求新增的读取依赖不回写这份快照。

关系树可展示预测绑定，但导航与重命名只采用确定的实际关系。几何锚点作为元数据保留，编辑器不绘制源码箭头。

## 扩展补充的信息

以下数据由 reader、展开语法或其他官方接口提供，不是 Check Syntax 原生回调。

| 数据 | 来源与用途 |
| --- | --- |
| `identifierKind` | 根据真实语法绑定补充宏、参数和函数类别；展开后 `quote` 操数中的源码符号提供 `datum` 类别 |
| `sourceForm` | 标准源码形式的真实绑定，供定义和参数模型使用 |
| `outline` | 核心定义的源码范围和类别 |
| `application` | 展开后的真实调用及操作符位置 |
| `callBinding` | 通过按 phase 建立的 `free-id-table` 将调用标识符关联到本地定义，比较规则为 `free-identifier=?` |

reader 提供完整表达式范围、嵌套和原始参数表。可选及关键字调用通过 `racket/keyword-transform` 恢复原操作符；准引用的求值边界由 expander 决定，`quote-syntax` 不按普通数据处理。

标准源码形式先按 reader 的准确范围和名称匹配，再通过真实绑定确认。展开可能为源码来源附加宏作用域，因此不能仅因 `syntax-original?` 为假就丢弃该来源。

函数识别共用 `lambda-expression?`，依据展开后的 `#%plain-lambda` 和 `case-lambda`；`value-binding-kind` 同时提供函数着色与补全类别。`let-values` 与 `letrec-values` 通过 `walk-value-binders` 共同保留绑定子句的 `origin`、记录函数类别并遍历绑定标识符，避免内部定义的来源处理分叉。参数类别则将源码形参范围与展开后的真实绑定匹配，不仅依赖核心 lambda 中的位置。导入候选只保留作用域，不伪造位于 require 子句的本地定义位置。

其他功能也各有来源：词法编辑使用 `syntax-color`，精确补全结合展开上下文与模块导出信息，文档摘要使用 `scribble/blueboxes`，REPL 使用独立的 Racket 终端进程。lexer 未分类的符号不会统一标为变量，普通常量使用 `racketConstant`。

## 名称与冲突请求

前端向原语义 worker 发送 `rename` 请求，传入新名称和需要调用的冲突回调 ID。后端用 reader 读取单个标识符，返回统一的 `RenameResult`：

| 字段 | 含义 |
| --- | --- |
| `name` | 解码后的符号名称，用于绑定名称比较 |
| `text` | 可写回源码的标识符拼写，包含所需转义 |
| `conflicts` | 报告名称冲突的回调 ID 列表 |

空 ID 列表只进行名称读取，不表示所有绑定均无冲突。回调闭包保留在生成它们的 worker 中，ID 不能跨会话复用。冲突列表为空也不能替代重新展开；完整的修改流程见[绑定与重命名](ARCHITECTURE.md#绑定与重命名)。

## 边界

宏可能产生重复、虚拟或缺失的源码位置，某些模块或 binding space 也无法恢复唯一目标。此时保留可展示的数据；需要确定源码或绑定的操作会拒绝执行，不按同名文本猜测。

完整展开失败时不提供部分语义结果。编辑期间的旧颜色仅用于显示，历史名称仅用于补全建议。`racket/load` 和重名定义整理均不调用 Check Syntax。
